#!/usr/bin/env python3
"""
Muse EEG headband connection bridge for glass-1.

Uses muselsl's Muse class directly (stream() blocks forever). Communicates
with Electron via JSON lines on stdout only; muselsl log output goes to stderr.
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from typing import Any, Dict, List, Optional

from jaw_click_detector import JawClickDetector
from head_gesture_detector import HeadGestureDetector

# Keep stdout JSON-only — muselsl prints connection logs to stdout by default.
IPC_OUT = sys.stdout
sys.stdout = sys.stderr

SCAN_TIMEOUT = 10.5
STREAM_SAMPLE_TIMEOUT = 8.0
RECONNECT_COOLDOWN = 2.0
FIRST_SAMPLE_TIMEOUT = 20.0
TELEMETRY_INTERVAL = 0.05  # 20 Hz — avoids flooding the stdout pipe
DEBUG_LOG_PATH = str(
    __import__("pathlib").Path(__file__).resolve().parent.parent / ".cursor" / "debug-ab9500.log"
)


def _agent_log(hypothesis_id: str, location: str, message: str, data: Optional[Dict[str, Any]] = None) -> None:
    # region agent log
    try:
        from pathlib import Path

        log_path = Path(DEBUG_LOG_PATH)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {
                        "sessionId": "ab9500",
                        "hypothesisId": hypothesis_id,
                        "location": location,
                        "message": message,
                        "data": data or {},
                        "timestamp": int(time.time() * 1000),
                    }
                )
                + "\n"
            )
    except Exception:
        pass
    # endregion

try:
    import bleak
    import numpy as np
    from muselsl import backends as muse_backends
    from muselsl import list_muses
    from muselsl.constants import (
        AUTO_DISCONNECT_DELAY,
        LSL_EEG_CHUNK,
        MUSE_ACCELEROMETER_SCALE_FACTOR,
        MUSE_GYRO_SCALE_FACTOR,
        MUSE_NB_EEG_CHANNELS,
        MUSE_SAMPLING_EEG_RATE,
    )
    from muselsl.muse import Muse
    from pylsl import StreamInfo, StreamOutlet

    try:
        import muse_athena_protocol as athena_proto
        from muse_realtime_decoder import MuseRealtimeDecoder

        ATHENA_AVAILABLE = True
    except ImportError:
        athena_proto = None
        MuseRealtimeDecoder = None
        ATHENA_AVAILABLE = False
except ImportError as exc:
    ATHENA_AVAILABLE = False
    athena_proto = None
    MuseRealtimeDecoder = None
    muse_backends = None
    IPC_OUT.write(
        json.dumps(
            {
                "type": "error",
                "message": (
                    f"Muse dependencies missing ({exc}). Run: ./scripts/setup-muse.sh"
                ),
            }
        )
        + "\n"
    )
    IPC_OUT.flush()
    sys.exit(1)


def emit(msg: Dict[str, Any]) -> None:
    IPC_OUT.write(json.dumps(msg) + "\n")
    IPC_OUT.flush()


def emit_status(state: str, **extra: Any) -> None:
    emit({"type": "status", "state": state, **extra})


def bleak_sleep(seconds: float) -> None:
    """Bleak notifications require the asyncio loop to run (muselsl.backends.sleep)."""
    if muse_backends is not None:
        muse_backends.sleep(seconds)
    else:
        time.sleep(seconds)


def wait_until(event: threading.Event, timeout: float, poll: float = 0.05) -> bool:
    """Wait for an event while pumping the Bleak asyncio loop."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if event.is_set():
            return True
        bleak_sleep(min(poll, max(0.0, deadline - time.time())))
    return event.is_set()


async def _device_supports_athena(address: str) -> bool:
    if not ATHENA_AVAILABLE or athena_proto is None:
        return False
    try:
        async with bleak.BleakClient(address, timeout=15.0) as client:
            sensor_uuid = athena_proto.SENSOR_UUID.lower()
            for service in client.services:
                for char in service.characteristics:
                    if char.uuid.lower() == sensor_uuid:
                        return True
    except Exception:
        return False
    return False


def scan_all_ble(timeout: float = SCAN_TIMEOUT) -> List[dict]:
    devices = asyncio.run(bleak.BleakScanner.discover(timeout))
    return [{"name": d.name or "", "address": d.address} for d in devices]


def pick_muse_devices(all_devices: List[dict], muses: List[dict]) -> List[dict]:
    seen = set()
    results: List[dict] = []

    for muse in muses:
        addr = muse.get("address", "")
        if addr and addr not in seen:
            seen.add(addr)
            results.append(
                {
                    "name": muse.get("name") or "Muse",
                    "address": addr,
                    "source": "muselsl",
                }
            )

    for device in all_devices:
        name = device.get("name") or ""
        addr = device.get("address", "")
        if not addr or addr in seen:
            continue
        lower = name.lower()
        if "muse" in lower or "bci" in lower or "ty" in lower:
            seen.add(addr)
            results.append({"name": name or "Muse", "address": addr, "source": "ble"})

    return sorted(results, key=lambda d: d["name"].lower())


def create_eeg_outlet(address: str) -> StreamOutlet:
    info = StreamInfo(
        "Muse",
        "EEG",
        MUSE_NB_EEG_CHANNELS,
        MUSE_SAMPLING_EEG_RATE,
        "float32",
        f"Muse{address}",
    )
    info.desc().append_child_value("manufacturer", "Muse")
    channels = info.desc().append_child("channels")
    for label in ["TP9", "AF7", "AF8", "TP10", "Right AUX"]:
        channels.append_child("channel").append_child_value("label", label)
    return StreamOutlet(info, LSL_EEG_CHUNK)


def latest_imu_sample(samples: np.ndarray) -> List[float]:
    return [float(samples[i, -1]) for i in range(3)]


class MuseWithImu(Muse):
    """muselsl drops IMU packets on bleak when GATT handles don't match pygatt."""

    def _handle_acc(self, handle, packet):
        timestamps = [self.time_func()] * 3
        self.last_timestamp = timestamps[-1]
        _, samples = self._unpack_imu_channel(
            packet, scale=MUSE_ACCELEROMETER_SCALE_FACTOR
        )
        if self.callback_acc:
            self.callback_acc(samples, timestamps)

    def _handle_gyro(self, handle, packet):
        timestamps = [self.time_func()] * 3
        self.last_timestamp = timestamps[-1]
        _, samples = self._unpack_imu_channel(
            packet, scale=MUSE_GYRO_SCALE_FACTOR
        )
        if self.callback_gyro:
            self.callback_gyro(samples, timestamps)


class MuseBleakBridge(MuseWithImu):
    """Bleak on macOS may report declaration/value handles inconsistently."""

    EEG_HANDLE_INDEX = {
        31: 0,
        32: 0,
        33: 0,
        34: 1,
        35: 1,
        36: 1,
        37: 2,
        38: 2,
        39: 2,
        40: 3,
        41: 3,
        42: 3,
        43: 4,
        44: 4,
        45: 4,
    }
    EEG_TRIGGER_HANDLE = 35

    def _resolve_eeg_index(self, handle: int) -> int:
        if handle in self.EEG_HANDLE_INDEX:
            return self.EEG_HANDLE_INDEX[handle]
        return max(0, min(4, int((handle - 32) / 3)))

    def _handle_eeg(self, handle, data):
        if self.first_sample:
            self._init_timestamp_correction()
            self.first_sample = False

        timestamp = self.time_func()
        index = self._resolve_eeg_index(handle)
        tm, d = self._unpack_eeg_channel(data)

        if self.last_tm == 0:
            self.last_tm = tm - 1

        self.data[index] = d
        self.timestamps[index] = timestamp

        # muselsl fires the EEG callback after the last channel in the rotation (handle 35).
        if handle != self.EEG_TRIGGER_HANDLE:
            return

        if tm != self.last_tm + 1:
            if (tm - self.last_tm) != -65535:
                self.sample_index += 12 * (tm - self.last_tm + 1)

        self.last_tm = tm
        idxs = np.arange(0, 12) + self.sample_index
        self.sample_index += 12
        self._update_timestamp_correction(idxs[-1], np.nanmin(self.timestamps))
        timestamps = self.reg_params[1] * idxs + self.reg_params[0]
        if self.callback_eeg:
            self.callback_eeg(self.data, timestamps)
        self.last_timestamp = timestamps[-1]
        self._init_sample()


class MuseBridge:
    def __init__(self) -> None:
        self._running = True
        self._connected = False
        self._target: Optional[dict] = None
        self._muse: Optional[Muse] = None
        self._worker: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._last_sample_at = 0.0
        self._first_sample = threading.Event()
        self._user_disconnect = False
        self._last_telemetry_emit = 0.0
        self._last_imu_emit = 0.0
        self._latest_acc: Optional[List[float]] = None
        self._latest_gyro: Optional[List[float]] = None
        self._dbg_eeg_count = 0
        self._dbg_acc_count = 0
        self._dbg_gyro_count = 0
        self._dbg_telemetry_emit_count = 0
        self._last_packet_at = 0.0
        self._detector = JawClickDetector()
        self._head_gestures = HeadGestureDetector()

    def handle_command(self, command: dict) -> None:
        cmd = command.get("command")
        if cmd == "scan":
            self.scan()
        elif cmd == "calibrate":
            self._detector.start_calibration()
            emit(
                {
                    "type": "calibration",
                    "phase": "baseline",
                    "status": self._detector.status_text,
                    "calibrated": False,
                }
            )
        elif cmd == "connect_auto":
            last_address = command.get("lastAddress")
            threading.Thread(
                target=self.connect_auto,
                args=(last_address,),
                daemon=True,
            ).start()
        elif cmd == "connect":
            address = command.get("address")
            name = command.get("name") or "Muse"
            if not address:
                emit_status("error", message="Missing device address")
                return
            self.connect({"name": name, "address": address})
        elif cmd == "disconnect":
            self.disconnect(user_initiated=True)
        elif cmd == "stop":
            self.shutdown()
        else:
            emit({"type": "error", "message": f"Unknown command: {cmd}"})

    def _maybe_emit_imu(self, device: dict) -> None:
        now = time.time()
        if now - self._last_imu_emit < TELEMETRY_INTERVAL:
            return
        if self._latest_acc is None and self._latest_gyro is None:
            return

        self._last_imu_emit = now
        payload: Dict[str, Any] = {
            "type": "imu",
            "timestamp": now,
            "device": device,
        }
        if self._latest_acc is not None:
            payload["acc"] = self._latest_acc
        if self._latest_gyro is not None:
            payload["gyro"] = self._latest_gyro
        payload.update(self._gesture_state())
        emit(payload)

    def _gesture_state(self) -> Dict[str, Any]:
        g = self._head_gestures
        return {
            "last_head_gesture": g.last_gesture,
            "nod_count": g.nod_count,
            "shake_count": g.shake_count,
            "head_gesture_status": g.status_text,
            "yes_threshold_y": g.yes_threshold_y,
            "no_threshold_z": g.no_threshold_z,
            "peak_y_gyro": round(g.peak_y_mag, 1),
            "peak_z_gyro": round(g.peak_z_mag, 1),
            "head_motion_state": g.motion_state,
        }

    def _jaw_state(self) -> Dict[str, Any]:
        return {
            "calibrated": self._detector.is_calibrated,
            "click_count": self._detector.click_count,
            "status": self._detector.status_text,
            "threshold": self._detector.threshold,
            "calibration_phase": self._detector.phase.value,
            "jaw_score": round(self._detector.last_score, 2),
        }

    def _telemetry_payload(
        self, eeg: List[float], device: dict, timestamp: float
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "type": "telemetry",
            "eeg": eeg,
            "device": device,
            "timestamp": timestamp,
            **self._jaw_state(),
        }
        if self._latest_acc is not None:
            payload["acc"] = self._latest_acc
        if self._latest_gyro is not None:
            payload["gyro"] = self._latest_gyro
        payload.update(self._gesture_state())
        # region agent log
        self._dbg_telemetry_emit_count += 1
        if self._dbg_telemetry_emit_count <= 3 or self._dbg_telemetry_emit_count % 20 == 0:
            _agent_log(
                "A",
                "bridge.py:_telemetry_payload",
                "telemetry payload built",
                {
                    "count": self._dbg_telemetry_emit_count,
                    "eeg": payload.get("eeg"),
                    "hasAcc": payload.get("acc") is not None,
                    "hasGyro": payload.get("gyro") is not None,
                },
            )
        # endregion
        return payload

    def _deliver_eeg(
        self, eeg: List[float], device: dict, jaw_click: bool = False
    ) -> None:
        now = time.time()
        self._last_packet_at = now

        if jaw_click:
            emit(
                {
                    "type": "jaw_click",
                    "timestamp": now,
                    "click_count": self._detector.click_count,
                    "status": self._detector.status_text,
                    "device": device,
                }
            )

        self._dbg_eeg_count += 1
        if self._dbg_eeg_count <= 3 or self._dbg_eeg_count % 20 == 0:
            _agent_log(
                "A",
                "bridge.py:_deliver_eeg",
                "eeg sample",
                {"count": self._dbg_eeg_count, "eeg": eeg},
            )

        if not self._first_sample.is_set():
            self._first_sample.set()
            with self._lock:
                self._connected = True
            emit_status(
                "streaming",
                message=f"Connected — live EEG + IMU from {device.get('name') or 'Muse'}",
                device=device,
            )
            self._last_telemetry_emit = now
            emit(self._telemetry_payload(eeg, device, now))
        elif now - self._last_telemetry_emit >= TELEMETRY_INTERVAL:
            self._last_telemetry_emit = now
            emit(self._telemetry_payload(eeg, device, now))

    def _deliver_imu(
        self,
        device: dict,
        acc: Optional[List[float]] = None,
        gyro: Optional[List[float]] = None,
        head_gesture: Optional[str] = None,
    ) -> None:
        if head_gesture is not None:
            emit(
                {
                    "type": "head_gesture",
                    "gesture": head_gesture,
                    "nod_count": self._head_gestures.nod_count,
                    "shake_count": self._head_gestures.shake_count,
                    "status": self._head_gestures.status_text,
                    "device": device,
                }
            )

        if acc is not None:
            self._latest_acc = acc
            self._dbg_acc_count += 1
        if gyro is not None:
            self._latest_gyro = gyro
            self._dbg_gyro_count += 1
        if acc is not None and (self._dbg_acc_count <= 3 or self._dbg_acc_count % 20 == 0):
            _agent_log(
                "D",
                "bridge.py:_deliver_imu",
                "imu sample",
                {
                    "count": self._dbg_acc_count,
                    "acc": acc,
                    "gyro": gyro,
                    "latestGyro": self._latest_gyro,
                },
            )
        if gyro is not None and (self._dbg_gyro_count <= 3 or self._dbg_gyro_count % 20 == 0):
            _agent_log(
                "D",
                "bridge.py:_deliver_imu",
                "gyro sample",
                {"count": self._dbg_gyro_count, "gyro": gyro},
            )
        self._last_packet_at = time.time()
        self._maybe_emit_imu(device)

    async def _athena_session(self, device: dict) -> None:
        label = device.get("name") or "Muse"
        address = device["address"]
        decoder = MuseRealtimeDecoder()
        preset = "p1034"

        def handle_sensor(_sender: int, data: bytearray) -> None:
            decoded = decoder.decode(bytes(data))
            if decoded.eeg:
                channels = decoded.eeg
                try:
                    tp9 = channels["TP9"]
                    af7 = channels["AF7"]
                    af8 = channels["AF8"]
                    tp10 = channels["TP10"]
                    n = min(len(tp9), len(af7), len(af8), len(tp10))
                    jaw_click = False
                    for idx in range(n):
                        sample = [
                            float(tp9[idx]),
                            float(af7[idx]),
                            float(af8[idx]),
                            float(tp10[idx]),
                        ]
                        if self._detector.update(sample):
                            jaw_click = True
                    eeg = [float(tp9[-1]), float(af7[-1]), float(af8[-1]), float(tp10[-1])]
                except (KeyError, IndexError, TypeError):
                    pass
                else:
                    self._deliver_eeg(eeg, device, jaw_click=jaw_click)

            if decoded.imu:
                acc_rows = decoded.imu.get("accel") or []
                gyro_rows = decoded.imu.get("gyro") or []
                head_gesture = None
                now = time.time()
                for row in gyro_rows:
                    sample = [float(row[0]), float(row[1]), float(row[2])]
                    gesture = self._head_gestures.update(sample, now)
                    if gesture:
                        head_gesture = gesture
                acc = (
                    [float(acc_rows[-1][0]), float(acc_rows[-1][1]), float(acc_rows[-1][2])]
                    if acc_rows
                    else None
                )
                gyro = (
                    [float(gyro_rows[-1][0]), float(gyro_rows[-1][1]), float(gyro_rows[-1][2])]
                    if gyro_rows
                    else None
                )
                if acc is not None or gyro is not None:
                    self._deliver_imu(device, acc=acc, gyro=gyro, head_gesture=head_gesture)

        emit_status(
            "connecting",
            message=f"Connecting to {label}…",
            device=device,
        )
        _agent_log(
            "F",
            "bridge.py:_athena_session",
            "starting athena session",
            {"device": label, "preset": preset},
        )

        async with bleak.BleakClient(address, timeout=30.0) as client:

            async def control_handler(_sender: int, _data: bytearray) -> None:
                return

            await client.start_notify(athena_proto.CONTROL_UUID, control_handler)

            for description, cmd, delay in athena_proto.get_init_sequence(preset):
                if self._user_disconnect:
                    return
                await client.write_gatt_char(
                    athena_proto.CONTROL_UUID, cmd, response=False
                )
                await asyncio.sleep(delay)
                if description == "request status after preset":
                    await client.start_notify(
                        athena_proto.SENSOR_UUID, handle_sensor
                    )

            emit_status(
                "connected",
                message=f"Bluetooth connected to {label}. Starting EEG + IMU stream…",
                device=device,
            )

            deadline = time.time() + FIRST_SAMPLE_TIMEOUT
            while time.time() < deadline and not self._first_sample.is_set():
                if self._user_disconnect:
                    return
                await asyncio.sleep(0.1)

            if not self._first_sample.is_set():
                _agent_log(
                    "F",
                    "bridge.py:_athena_session",
                    "athena no first sample",
                    {"device": label},
                )
                return

            while self._running and not self._user_disconnect:
                if time.time() - self._last_packet_at >= AUTO_DISCONNECT_DELAY:
                    emit_status(
                        "connecting",
                        message="Reconnecting…",
                        device=device,
                    )
                    return
                await asyncio.sleep(0.25)

            try:
                await client.write_gatt_char(
                    athena_proto.CONTROL_UUID, athena_proto.COMMANDS["h"], response=False
                )
            except Exception:
                pass

    def scan(self) -> None:
        emit_status("scanning", message="Scanning for Muse headbands…")
        try:
            all_devices = scan_all_ble()
            muses = list_muses()
            devices = pick_muse_devices(all_devices, muses)
            emit({"type": "devices", "devices": devices})
            if devices:
                emit_status(
                    "ready",
                    message=f"Found {len(devices)} device(s). Select one to pair.",
                    devices=devices,
                )
            else:
                emit_status(
                    "ready",
                    message=(
                        "No Muse found. Power on the headband, close the Muse app, "
                        "and grant Bluetooth access."
                    ),
                    devices=[],
                )
        except Exception as exc:
            emit_status("error", message=str(exc))

    def connect_auto(self, last_address: Optional[str] = None) -> None:
        emit_status("connecting", message="Looking for your Muse…")
        try:
            all_devices = scan_all_ble()
            muses = list_muses()
            devices = pick_muse_devices(all_devices, muses)

            if not devices:
                emit_status(
                    "error",
                    message=(
                        "No Muse found nearby. Power on the headband, "
                        "close the Muse app, and try again."
                    ),
                )
                return

            device = None
            if last_address:
                for candidate in devices:
                    if candidate["address"].lower() == last_address.lower():
                        device = candidate
                        break

            if not device:
                device = devices[0]

            emit_status(
                "connecting",
                message=f"Connecting to {device.get('name') or 'Muse'}…",
                device=device,
            )
            self.connect(device)
        except Exception as exc:
            emit_status("error", message=str(exc))

    def connect(self, device: dict) -> None:
        if self._worker and self._worker.is_alive():
            self._user_disconnect = True
            self._cleanup_muse()
            self._worker.join(timeout=3.0)

        self._user_disconnect = False
        self._first_sample.clear()
        self._latest_acc = None
        self._latest_gyro = None
        self._last_imu_emit = 0.0
        self._worker = threading.Thread(
            target=self._connect_worker, args=(device,), daemon=True
        )
        self._worker.start()

    def _connect_worker(self, device: dict) -> None:
        label = device.get("name") or "Muse"

        with self._lock:
            self._target = device

        _agent_log(
            "F",
            "bridge.py:_connect_worker",
            "connect start",
            {"device": label, "athenaAvailable": ATHENA_AVAILABLE},
        )

        use_athena = False
        if ATHENA_AVAILABLE:
            try:
                use_athena = asyncio.run(_device_supports_athena(device["address"]))
            except Exception:
                use_athena = False
            _agent_log(
                "F",
                "bridge.py:_connect_worker",
                "athena probe",
                {"device": label, "useAthena": use_athena},
            )

        if use_athena:
            self._first_sample.clear()
            self._latest_acc = None
            self._latest_gyro = None
            self._last_imu_emit = 0.0
            self._last_packet_at = time.time()
            try:
                asyncio.run(self._athena_session(device))
            except Exception as exc:
                _agent_log(
                    "F",
                    "bridge.py:_athena_session",
                    "athena exception",
                    {"error": str(exc)},
                )

            if self._user_disconnect:
                return

            if self._first_sample.is_set():
                if self._running and not self._user_disconnect:
                    if time.time() - self._last_packet_at >= AUTO_DISCONNECT_DELAY:
                        time.sleep(RECONNECT_COOLDOWN)
                        self._connect_worker(device)
                return

        if self._user_disconnect:
            return

        _agent_log(
            "F",
            "bridge.py:_connect_worker",
            "falling back to legacy muselsl",
            {"device": label},
        )
        self._connect_legacy_worker(device)

    def _connect_legacy_worker(self, device: dict) -> None:
        label = device.get("name") or "Muse"
        address = device["address"]

        emit_status(
            "connecting",
            message=f"Connecting to {label}…",
            device=device,
        )

        outlet = create_eeg_outlet(address)

        def push_eeg(data: np.ndarray, timestamps: np.ndarray) -> None:
            jaw_click = False
            for idx in range(data.shape[1]):
                outlet.push_sample(data[:, idx], timestamps[idx])
                if data.shape[0] >= 4:
                    sample = [float(data[i, idx]) for i in range(4)]
                    if self._detector.update(sample):
                        jaw_click = True
            eeg = [float(data[i, -1]) for i in range(min(4, data.shape[0]))]
            self._deliver_eeg(eeg, device, jaw_click=jaw_click)

        def push_acc(data: np.ndarray, _timestamps: np.ndarray) -> None:
            acc = latest_imu_sample(data)
            self._deliver_imu(device, acc=acc)

        def push_gyro(data: np.ndarray, _timestamps: np.ndarray) -> None:
            head_gesture = None
            now = time.time()
            for idx in range(data.shape[1]):
                sample = [float(data[i, idx]) for i in range(min(3, data.shape[0]))]
                gesture = self._head_gestures.update(sample, now)
                if gesture:
                    head_gesture = gesture
            gyro = latest_imu_sample(data)
            self._deliver_imu(device, gyro=gyro, head_gesture=head_gesture)

        muse = MuseBleakBridge(
            address=address,
            callback_eeg=push_eeg,
            callback_acc=push_acc,
            callback_gyro=push_gyro,
            backend="bleak",
            name=label,
            preset="p21",
        )

        try:
            connected = muse.connect(retries=3)
            if not connected:
                emit_status(
                    "error",
                    message=(
                        f"Could not connect to {label}. "
                        "Check Bluetooth, close the Muse app, and try again."
                    ),
                    device=device,
                )
                return

            with self._lock:
                self._muse = muse
                self._connected = True

            emit_status(
                "connected",
                message=f"Bluetooth connected to {label}. Starting EEG + IMU stream…",
                device=device,
            )

            muse.start()

            if not wait_until(self._first_sample, FIRST_SAMPLE_TIMEOUT):
                emit_status(
                    "error",
                    message=(
                        f"Connected to {label} but no EEG data yet. "
                        "Adjust the headband fit and try again."
                    ),
                    device=device,
                )
                self._cleanup_muse()
                return

            while self._running and not self._user_disconnect:
                with self._lock:
                    active = self._connected and self._muse is not None

                if not active:
                    break

                if time.time() - self._last_packet_at >= AUTO_DISCONNECT_DELAY:
                    emit_status(
                        "connecting",
                        message="Reconnecting…",
                        device=device,
                    )
                    self._cleanup_muse()
                    if self._running and not self._user_disconnect:
                        bleak_sleep(RECONNECT_COOLDOWN)
                        self._connect_worker(device)
                    return

                bleak_sleep(0.25)

        except Exception as exc:
            emit_status("error", message=f"Connection failed: {exc}", device=device)
            self._cleanup_muse()

    def disconnect(self, user_initiated: bool = False) -> None:
        self._user_disconnect = user_initiated
        device = self._target
        self._cleanup_muse()

        if self._worker and self._worker.is_alive():
            self._worker.join(timeout=3.0)

        if user_initiated:
            self._target = None
            emit_status("idle", message="Not connected")
        elif device:
            emit_status(
                "connecting",
                message="Connection lost — reconnecting…",
                device=device,
            )

    def _cleanup_muse(self) -> None:
        with self._lock:
            muse = self._muse
            self._muse = None
            self._connected = False

        if muse:
            try:
                muse.stop()
            except Exception:
                pass
            try:
                muse.disconnect()
            except Exception:
                pass

    def shutdown(self) -> None:
        self._running = False
        self.disconnect(user_initiated=True)
        emit_status("idle", message="Bridge stopped")
        sys.exit(0)


def read_commands(bridge: MuseBridge) -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            bridge.handle_command(json.loads(line))
        except json.JSONDecodeError:
            emit({"type": "error", "message": "Invalid JSON command"})


def main() -> None:
    bridge = MuseBridge()
    emit_status("idle", message="Muse bridge ready")
    reader = threading.Thread(target=read_commands, args=(bridge,), daemon=True)
    reader.start()

    try:
        while bridge._running:
            time.sleep(0.5)
    except KeyboardInterrupt:
        bridge.shutdown()


if __name__ == "__main__":
    main()

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

# Keep stdout JSON-only — muselsl prints connection logs to stdout by default.
IPC_OUT = sys.stdout
sys.stdout = sys.stderr

SCAN_TIMEOUT = 10.5
STREAM_SAMPLE_TIMEOUT = 8.0
RECONNECT_COOLDOWN = 2.0
FIRST_SAMPLE_TIMEOUT = 20.0
TELEMETRY_INTERVAL = 0.05  # 20 Hz — avoids flooding the stdout pipe

try:
    import bleak
    import numpy as np
    from muselsl import list_muses
    from muselsl.constants import (
        AUTO_DISCONNECT_DELAY,
        LSL_EEG_CHUNK,
        MUSE_NB_EEG_CHANNELS,
        MUSE_SAMPLING_EEG_RATE,
    )
    from muselsl.muse import Muse
    from pylsl import StreamInfo, StreamOutlet
except ImportError as exc:
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

    def handle_command(self, command: dict) -> None:
        cmd = command.get("command")
        if cmd == "scan":
            self.scan()
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
        self._worker = threading.Thread(
            target=self._connect_worker, args=(device,), daemon=True
        )
        self._worker.start()

    def _connect_worker(self, device: dict) -> None:
        label = device.get("name") or "Muse"
        address = device["address"]

        with self._lock:
            self._target = device

        emit_status(
            "connecting",
            message=f"Connecting to {label}…",
            device=device,
        )

        outlet = create_eeg_outlet(address)
        first_sample_sent = False

        def push_eeg(data: np.ndarray, timestamps: np.ndarray) -> None:
            nonlocal first_sample_sent
            for idx in range(data.shape[1]):
                outlet.push_sample(data[:, idx], timestamps[idx])

            now = time.time()
            self._last_sample_at = now
            eeg = [float(data[i, -1]) for i in range(min(4, data.shape[0]))]

            if not first_sample_sent:
                first_sample_sent = True
                self._first_sample.set()
                with self._lock:
                    self._connected = True
                emit_status(
                    "streaming",
                    message=f"Connected — live EEG from {label}",
                    device=device,
                )
                self._last_telemetry_emit = now
                emit(
                    {
                        "type": "telemetry",
                        "eeg": eeg,
                        "device": device,
                        "timestamp": now,
                    }
                )
            elif now - self._last_telemetry_emit >= TELEMETRY_INTERVAL:
                self._last_telemetry_emit = now
                emit(
                    {
                        "type": "telemetry",
                        "eeg": eeg,
                        "device": device,
                        "timestamp": now,
                    }
                )

        muse = Muse(
            address=address,
            callback_eeg=push_eeg,
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
                message=f"Bluetooth connected to {label}. Starting EEG stream…",
                device=device,
            )

            muse.start()

            if not self._first_sample.wait(timeout=FIRST_SAMPLE_TIMEOUT):
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

                if time.time() - muse.last_timestamp >= AUTO_DISCONNECT_DELAY:
                    emit_status(
                        "connecting",
                        message="Reconnecting…",
                        device=device,
                    )
                    self._cleanup_muse()
                    if self._running and not self._user_disconnect:
                        time.sleep(RECONNECT_COOLDOWN)
                        self._connect_worker(device)
                    return

                time.sleep(0.25)

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

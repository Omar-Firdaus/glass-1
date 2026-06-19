"""Detect head nod (yes) and shake (no) from gyroscope axis magnitude."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Literal, Optional, Tuple

HeadGesture = Literal["yes", "no"]

# Gyroscope °/s — Y nod (yes), Z shake (no)
YES_THRESHOLD_Y = 30.0
NO_THRESHOLD_Z = 80.0


@dataclass
class HeadGestureDetector:
    yes_threshold_y: float = YES_THRESHOLD_Y
    no_threshold_z: float = NO_THRESHOLD_Z
    window_seconds: float = 0.2
    refractory_seconds: float = 0.9
    opposite_lock_seconds: float = 1.4
    active_motion_fraction: float = 0.42

    nod_count: int = 0
    shake_count: int = 0
    last_gesture: Optional[HeadGesture] = None
    motion_state: str = "idle"
    status_text: str = (
        f"Nod yes when Y ≥ {YES_THRESHOLD_Y:.0f} °/s · "
        f"shake no when Z ≥ {NO_THRESHOLD_Z:.0f} °/s."
    )

    last_y_mag: float = 0.0
    last_z_mag: float = 0.0
    peak_y_mag: float = 0.0
    peak_z_mag: float = 0.0

    _y_window: Deque[Tuple[float, float]] = field(default_factory=deque)
    _z_window: Deque[Tuple[float, float]] = field(default_factory=deque)
    _last_detection_at: Optional[float] = None
    _last_gesture_type: Optional[HeadGesture] = None

    def update(self, gyro: list[float], now: float) -> Optional[HeadGesture]:
        if len(gyro) < 3:
            return None

        y_mag = abs(float(gyro[1]))
        z_mag = abs(float(gyro[2]))
        self.last_y_mag = y_mag
        self.last_z_mag = z_mag

        self._y_window.append((now, y_mag))
        self._z_window.append((now, z_mag))
        self._trim(self._y_window, now)
        self._trim(self._z_window, now)

        if not self._y_window:
            return None

        peak_y = max(v for _, v in self._y_window)
        peak_z = max(v for _, v in self._z_window)
        self.peak_y_mag = peak_y
        self.peak_z_mag = peak_z

        y_active = peak_y >= self.yes_threshold_y * self.active_motion_fraction
        z_active = peak_z >= self.no_threshold_z * self.active_motion_fraction
        self._update_motion_state(y_active, z_active, peak_y, peak_z)

        if self._last_detection_at is not None:
            if now - self._last_detection_at < self.refractory_seconds:
                return None

        y_hit = peak_y >= self.yes_threshold_y
        z_hit = peak_z >= self.no_threshold_z

        y_hit, z_hit = self._apply_motion_exclusion(
            y_hit, z_hit, y_active, z_active, peak_y, peak_z, now
        )

        if not y_hit and not z_hit:
            return None

        if y_hit and z_hit:
            gesture: HeadGesture = "yes" if peak_y >= peak_z else "no"
        elif y_hit:
            gesture = "yes"
        else:
            gesture = "no"

        self._last_detection_at = now
        self._last_gesture_type = gesture
        self._y_window.clear()
        self._z_window.clear()
        self.last_gesture = gesture

        if gesture == "yes":
            self.nod_count += 1
            self.status_text = (
                f"Yes (nod) — Y {peak_y:.0f} °/s ≥ {self.yes_threshold_y:.0f} "
                f"({self.nod_count} total)"
            )
        else:
            self.shake_count += 1
            self.status_text = (
                f"No (shake) — Z {peak_z:.0f} °/s ≥ {self.no_threshold_z:.0f} "
                f"({self.shake_count} total)"
            )

        return gesture

    def _update_motion_state(
        self,
        y_active: bool,
        z_active: bool,
        peak_y: float,
        peak_z: float,
    ) -> None:
        y_ratio = peak_y / self.yes_threshold_y
        z_ratio = peak_z / self.no_threshold_z

        if y_active and z_active:
            self.motion_state = "nodding" if y_ratio >= z_ratio else "shaking"
        elif y_active:
            self.motion_state = "nodding"
        elif z_active:
            self.motion_state = "shaking"
        else:
            self.motion_state = "idle"

    def _apply_motion_exclusion(
        self,
        y_hit: bool,
        z_hit: bool,
        y_active: bool,
        z_active: bool,
        peak_y: float,
        peak_z: float,
        now: float,
    ) -> Tuple[bool, bool]:
        """Block the opposite gesture during active motion or shortly after one fires."""

        if self.motion_state == "nodding":
            z_hit = False
        elif self.motion_state == "shaking":
            y_hit = False

        if self._last_gesture_type is not None and self._last_detection_at is not None:
            elapsed = now - self._last_detection_at
            if elapsed < self.opposite_lock_seconds:
                if self._last_gesture_type == "yes":
                    z_hit = False
                else:
                    y_hit = False

        if y_active and z_hit and (peak_y / self.yes_threshold_y) >= (peak_z / self.no_threshold_z):
            z_hit = False
        if z_active and y_hit and (peak_z / self.no_threshold_z) > (peak_y / self.yes_threshold_y):
            y_hit = False

        return y_hit, z_hit

    def _trim(self, window: Deque[Tuple[float, float]], now: float) -> None:
        cutoff = now - self.window_seconds
        while window and window[0][0] < cutoff:
            window.popleft()

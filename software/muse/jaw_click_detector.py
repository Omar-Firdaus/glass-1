"""EEG preprocessing and jaw-click detection with EMG-focused filtering."""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Deque, List, Optional


SAMPLE_RATE = 256.0


@dataclass
class ChannelFilterState:
    hp_y: float = 0.0
    hp_x_prev: float = 0.0
    env: float = 0.0
    env_prev: float = 0.0


class EmgFeatureExtractor:
    """High-pass + envelope to emphasize jaw EMG transients over slow EEG drift."""

    def __init__(
        self,
        sample_rate: float = SAMPLE_RATE,
        hp_cutoff_hz: float = 2.5,
        env_alpha: float = 0.18,
    ) -> None:
        self.sample_rate = sample_rate
        rc = 1.0 / (2.0 * math.pi * hp_cutoff_hz)
        dt = 1.0 / sample_rate
        self._hp_alpha = rc / (rc + dt)
        self._env_alpha = env_alpha

    def process(self, sample: float, state: ChannelFilterState) -> float:
        hp = self._hp_alpha * (state.hp_y + sample - state.hp_x_prev)
        state.hp_y = hp
        state.hp_x_prev = sample

        rect = abs(hp)
        state.env = state.env + self._env_alpha * (rect - state.env)
        return state.env


class CalibrationPhase(Enum):
    IDLE = "idle"
    BASELINE = "baseline"
    CLENCH = "clench"


@dataclass
class JawClickDetector:
    clench_z: float = 3.1
    adapt_alpha: float = 0.008
    adapt_alpha_calibrated: float = 0.0035
    refractory_seconds: float = 0.8
    confirm_samples: int = 14
    threshold_margin: float = 1.32
    max_channel_spread: float = 2.35
    min_prominence_ratio: float = 0.42
    min_threshold_floor: float = 3.6

    previous_env: List[float] = field(default_factory=list)
    ema_mean: List[float] = field(default_factory=lambda: [8.0] * 4)
    ema_var: List[float] = field(default_factory=lambda: [25.0] * 4)
    filter_states: List[ChannelFilterState] = field(default_factory=list)
    _feature_extractor: EmgFeatureExtractor = field(default_factory=EmgFeatureExtractor)
    _recent_scores: Deque[float] = field(default_factory=lambda: deque(maxlen=48))

    last_detection_at: Optional[datetime] = None

    phase: CalibrationPhase = CalibrationPhase.IDLE
    phase_ends_at: Optional[datetime] = None
    baseline_scores: List[float] = field(default_factory=list)
    clench_scores: List[float] = field(default_factory=list)
    baseline_active: List[int] = field(default_factory=list)
    clench_active: List[int] = field(default_factory=list)

    rest_score_mean: float = 0.0
    rest_score_p95: float = 0.0

    status_text: str = "Jaw click: not calibrated. Press Calibrate."
    threshold: float = 5.0
    min_active_channels: int = 4
    is_calibrated: bool = False
    click_count: int = 0
    last_score: float = 0.0

    def start_calibration(self, now: Optional[datetime] = None) -> None:
        now = now or datetime.utcnow()
        self.phase = CalibrationPhase.BASELINE
        self.phase_ends_at = now.timestamp() + 2.5
        self.baseline_scores.clear()
        self.clench_scores.clear()
        self.baseline_active.clear()
        self.clench_active.clear()
        self._recent_scores.clear()
        self.is_calibrated = False
        self.status_text = "Jaw click calibration: relax jaw and keep still for 2.5s..."

    def update(self, eeg: List[float], now: Optional[datetime] = None) -> bool:
        now = now or datetime.utcnow()
        now_ts = now.timestamp()

        if len(eeg) != 4:
            return False

        if len(self.filter_states) != 4:
            self.filter_states = [ChannelFilterState() for _ in range(4)]
            self.previous_env = [0.0] * 4
            return False

        z_scores: List[float] = []
        env_deltas: List[float] = []
        for i in range(4):
            env = self._feature_extractor.process(float(eeg[i]), self.filter_states[i])
            delta = abs(env - self.previous_env[i])
            self.previous_env[i] = env
            env_deltas.append(delta)

            mean = self.ema_mean[i]
            variance = max(0.5, self.ema_var[i])
            std = math.sqrt(variance)
            z_scores.append(max(0.0, (delta - mean) / std))

        active = sum(1 for z in z_scores if z > self.clench_z)
        score = sum(z_scores) / len(z_scores)
        self.last_score = score
        self._recent_scores.append(score)
        self._handle_calibration(score, active, now_ts)

        if self._should_adapt_baseline(score):
            alpha = self.adapt_alpha_calibrated if self.is_calibrated else self.adapt_alpha
            for i in range(4):
                delta = env_deltas[i]
                diff = delta - self.ema_mean[i]
                self.ema_mean[i] += alpha * diff
                self.ema_var[i] += alpha * ((diff * diff) - self.ema_var[i])

        if not self.is_calibrated:
            return False

        if self.last_detection_at is not None:
            elapsed = (now - self.last_detection_at).total_seconds()
            if elapsed <= self.refractory_seconds:
                return False

        if not self._passes_temporal_gate(score):
            return False

        if score < self.threshold or active < self.min_active_channels:
            return False

        if active < 4 and score < self.threshold * 1.15:
            return False

        if not self._channels_consistent(z_scores, active):
            return False

        self.last_detection_at = now
        self.click_count += 1
        self.status_text = (
            f"Jaw click detected. score {score:.2f} >= {self.threshold:.2f} ({active}ch)"
        )
        self._recent_scores.clear()
        return True

    def _passes_temporal_gate(self, score: float) -> bool:
        """Require a sustained EMG burst (~55ms+) with a clear peak above quiet baseline."""
        if len(self._recent_scores) < self.confirm_samples:
            return False

        recent = list(self._recent_scores)[-self.confirm_samples :]
        soft = self.threshold * 0.7
        strong_count = sum(1 for s in recent if s >= soft)
        if strong_count < int(self.confirm_samples * 0.68):
            return False

        peak = max(recent)
        if score < peak * 0.94:
            return False

        if len(self._recent_scores) >= self.confirm_samples + 8:
            quiet = list(self._recent_scores)[-(self.confirm_samples + 8) : -(self.confirm_samples // 2)]
            quiet_median = _median(quiet)
            prominence = score - quiet_median
            min_prominence = max(
                self.threshold * self.min_prominence_ratio,
                self.rest_score_p95 * 1.35,
            )
            if prominence < min_prominence:
                return False

        return True

    def _channels_consistent(self, z_scores: List[float], active: int) -> bool:
        """Jaw clenches are bilateral with temporal involvement; blinks spike frontal only."""
        if active < self.min_active_channels:
            return False

        active_z = sorted([z for z in z_scores if z > self.clench_z * 0.88], reverse=True)
        if len(active_z) < self.min_active_channels:
            return False

        peak = active_z[0]
        median_active = active_z[len(active_z) // 2]
        if median_active <= 0.01:
            return False

        if peak / median_active > self.max_channel_spread:
            return False

        temporal_z = z_scores[0] + z_scores[3]
        frontal_z = z_scores[1] + z_scores[2]
        if frontal_z > temporal_z * 2.6 and temporal_z < self.clench_z * 1.35:
            return False

        if max(z_scores[0], z_scores[3]) < self.clench_z * 0.82:
            return False

        left = max(z_scores[0], z_scores[1])
        right = max(z_scores[2], z_scores[3])
        if min(left, right) < self.clench_z * 0.78:
            return False

        return True

    def _handle_calibration(self, score: float, active: int, now_ts: float) -> None:
        if self.phase == CalibrationPhase.IDLE:
            return
        if self.phase_ends_at is None:
            return

        if self.phase == CalibrationPhase.BASELINE:
            self.baseline_scores.append(score)
            self.baseline_active.append(active)
            if now_ts >= self.phase_ends_at:
                self.phase = CalibrationPhase.CLENCH
                self.phase_ends_at = now_ts + 4.0
                self.status_text = "Now do 4-5 firm jaw clenches over 4s..."
        elif self.phase == CalibrationPhase.CLENCH:
            self.clench_scores.append(score)
            self.clench_active.append(active)
            if now_ts >= self.phase_ends_at:
                self._finalize_calibration()

    def _finalize_calibration(self) -> None:
        self.phase = CalibrationPhase.IDLE
        self.phase_ends_at = None

        if len(self.baseline_scores) <= 10 or len(self.clench_scores) <= 10:
            self.status_text = "Jaw click calibration failed. Try again."
            self.is_calibrated = False
            return

        rest_mean = sum(self.baseline_scores) / len(self.baseline_scores)
        rest_std = _std(self.baseline_scores, rest_mean)
        rest_p95 = _percentile(self.baseline_scores, 0.95)
        clench_p85 = _percentile(self.clench_scores, 0.85)

        self.rest_score_mean = rest_mean
        self.rest_score_p95 = rest_p95

        candidate_a = rest_mean + (3.4 * rest_std)
        candidate_b = rest_p95 + max(0.65, (clench_p85 - rest_p95) * 0.58)
        raw_threshold = max(2.6, min(14.0, max(candidate_a, candidate_b)))
        self.threshold = max(self.min_threshold_floor, raw_threshold * self.threshold_margin)

        active_p75 = _percentile([float(v) for v in self.clench_active], 0.75)
        self.min_active_channels = max(3, min(4, int(round(active_p75))))

        self.is_calibrated = True
        self.status_text = (
            f"Jaw click calibrated (thr {self.threshold:.2f}, min {self.min_active_channels} ch)."
        )

    def _should_adapt_baseline(self, score: float) -> bool:
        if self.phase != CalibrationPhase.IDLE:
            return False
        if not self.is_calibrated:
            return True
        quiet_ceiling = max(self.threshold * 0.2, self.rest_score_p95 * 0.9)
        return score < quiet_ceiling


def _std(values: List[float], mean: float) -> float:
    if len(values) <= 1:
        return 1.0
    total = sum((v - mean) ** 2 for v in values)
    return math.sqrt(total / (len(values) - 1))


def _median(values: List[float]) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    mid = len(sorted_vals) // 2
    if len(sorted_vals) % 2:
        return sorted_vals[mid]
    return (sorted_vals[mid - 1] + sorted_vals[mid]) / 2.0


def _percentile(values: List[float], p: float) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    idx = int(round((len(sorted_vals) - 1) * max(0.0, min(1.0, p))))
    return sorted_vals[idx]

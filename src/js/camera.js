/**
 * Camera input — always uses the "PC Cam" device when available.
 */

const PREFERRED_CAMERA = 'PC Cam';

function matchesPreferredCamera(label) {
  const name = (label || '').trim();
  if (!name) return false;
  return name.toLowerCase().includes(PREFERRED_CAMERA.toLowerCase());
}

function pickPreferredCamera(devices) {
  const videoInputs = devices.filter((d) => d.kind === 'videoinput');
  if (!videoInputs.length) return null;

  const exact = videoInputs.find(
    (d) => d.label.trim().toLowerCase() === PREFERRED_CAMERA.toLowerCase()
  );
  if (exact) return exact;

  const partial = videoInputs.find((d) => matchesPreferredCamera(d.label));
  if (partial) return partial;

  return null;
}

function formatCameraList(devices) {
  const videoInputs = devices.filter((d) => d.kind === 'videoinput');
  if (!videoInputs.length) return 'none detected';
  return videoInputs.map((d) => d.label || '(unnamed)').join(', ');
}

class CameraManager {
  constructor() {
    this.stream = null;
    this.device = null;
    this.active = false;
    this.videoEl = null;
    this.onStatusChange = null;
  }

  bind(videoEl, onStatusChange) {
    this.videoEl = videoEl;
    this.onStatusChange = onStatusChange;
    this._statusListeners = this._statusListeners || [];
  }

  onStatus(callback) {
    this._statusListeners = this._statusListeners || [];
    this._statusListeners.push(callback);
    return () => {
      this._statusListeners = this._statusListeners.filter((cb) => cb !== callback);
    };
  }

  _notifyStatus(status) {
    if (this.onStatusChange) this.onStatusChange(status);
    (this._statusListeners || []).forEach((cb) => cb(status));
  }

  setStatus(state, message, extra = {}) {
    this._notifyStatus({ state, message, device: this.device, ...extra });
  }

  async listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  async ensureDeviceLabels() {
    let devices = await navigator.mediaDevices.enumerateDevices();
    const hasLabels = devices.some((d) => d.kind === 'videoinput' && d.label);

    if (!hasLabels) {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }

    return devices;
  }

  async resolvePreferredCamera() {
    const devices = await this.ensureDeviceLabels();
    const camera = pickPreferredCamera(devices);

    if (!camera) {
      throw new Error(
        `"${PREFERRED_CAMERA}" not found. Available cameras: ${formatCameraList(devices)}`
      );
    }

    return camera;
  }

  async start() {
    if (this.active) return;

    this.setStatus('starting', `Opening ${PREFERRED_CAMERA}…`);

    try {
      const camera = await this.resolvePreferredCamera();
      this.device = camera;

      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: camera.deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });

      const track = this.stream.getVideoTracks()[0];
      const activeId = track?.getSettings?.()?.deviceId;
      if (activeId && activeId !== camera.deviceId) {
        throw new Error(
          `Wrong camera opened. Expected "${PREFERRED_CAMERA}" (${camera.deviceId}).`
        );
      }

      if (this.videoEl) {
        this.videoEl.srcObject = this.stream;
        await this.videoEl.play();
        this.videoEl.closest('.camera-preview-wrap')?.classList.add('live');
      }

      this.active = true;
      this.setStatus('live', `Live — ${camera.label}`, { label: camera.label });
    } catch (err) {
      this.setStatus('error', err.message || 'Could not access camera');
      this.stop();
      throw err;
    }
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
      this.videoEl.closest('.camera-preview-wrap')?.classList.remove('live');
    }
    this.active = false;
    this.setStatus('idle', 'Camera off');
  }

  captureFrame() {
    if (!this.active || !this.videoEl) return null;

    const canvas = document.createElement('canvas');
    canvas.width = this.videoEl.videoWidth;
    canvas.height = this.videoEl.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.videoEl, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.85);
  }
}

const cameraManager = new CameraManager();

document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('camera-preview');
  const startBtn = document.getElementById('camera-start-btn');
  const stopBtn = document.getElementById('camera-stop-btn');
  const statusDot = document.getElementById('camera-status-dot');
  const statusLabel = document.getElementById('camera-status-label');
  const statusMessage = document.getElementById('camera-status-message');
  const deviceName = document.getElementById('camera-device-name');
  const errorBox = document.getElementById('camera-error');

  if (!video || !startBtn) return;

  cameraManager.bind(video, (status) => {
    if (statusDot) {
      statusDot.className = 'hw-dot';
      statusDot.classList.add(status.state === 'live' ? 'live' : status.state);
    }
    if (statusLabel) {
      const labels = {
        idle: 'Off',
        starting: 'Starting…',
        live: 'Live',
        error: 'Error',
      };
      statusLabel.textContent = labels[status.state] || status.state;
    }
    if (statusMessage) {
      statusMessage.textContent =
        status.state === 'live'
          ? status.message || 'Streaming'
          : status.state === 'idle'
            ? 'Not streaming'
            : status.message || '';
    }
    if (deviceName) {
      deviceName.textContent = status.label || '—';
      deviceName.closest('.camera-device-info')?.toggleAttribute(
        'hidden',
        status.state !== 'live'
      );
    }
    if (errorBox) {
      if (status.state === 'error') {
        errorBox.textContent = status.message;
        errorBox.hidden = false;
      } else {
        errorBox.hidden = true;
      }
    }
    if (startBtn) startBtn.disabled = status.state === 'starting' || status.state === 'live';
    if (stopBtn) stopBtn.hidden = status.state !== 'live';
  });

  startBtn.addEventListener('click', () => {
    cameraManager.start().catch(() => {});
  });

  stopBtn?.addEventListener('click', () => {
    cameraManager.stop();
  });

  document.querySelectorAll('.nav-item[data-panel]').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.panel !== 'hardware' && cameraManager.active) {
        cameraManager.stop();
      }
    });
  });

  window.camera = cameraManager;
});

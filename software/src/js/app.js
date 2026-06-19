const DEFAULT_SETTINGS = {
  glassesName: 'glass-1',
  museAutoConnect: false,
  museSampleRate: 256,
  cameraAutoStart: false,
  cameraResolution: '1280x720',
};

const EEG_LABELS = ['TP9', 'AF7', 'AF8', 'TP10'];
const IMU_AXIS_LABELS = ['X', 'Y', 'Z'];
const IMU_ACC_RANGE = 2.0;
const IMU_GYRO_RANGE = 200;
const STREAMING_STATES = new Set(['connected', 'streaming']);

let jawFlashTimer = null;
let gestureFlashTimer = null;
let cameraStream = null;
let cameraStarting = false;

let visionState = 'idle';
let pendingVisionImage = null;
let visionSpeechAudio = null;
let visionSpeechObjectUrl = null;
let visionUiCache = {
  state: 'idle',
  imageDataUrl: null,
  prompt: '',
  hint: '',
  analysis: null,
};

function initials(name) {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function bindViewNav() {
  const navItems = document.querySelectorAll('.app-nav-item');
  const views = document.querySelectorAll('.view');

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      switchToView(item.dataset.view, navItems, views);
    });
  });
}

function switchToView(viewId, navItems, views) {
  const nav = navItems || document.querySelectorAll('.app-nav-item');
  const panels = views || document.querySelectorAll('.view');
  nav.forEach((el) => el.classList.toggle('active', el.dataset.view === viewId));
  panels.forEach((view) => {
    view.classList.toggle('active', view.id === `view-${viewId}`);
  });
}

function switchToHomeView() {
  switchToView('home');
}

function bindSettingsNav() {
  const navItems = document.querySelectorAll('.settings-nav-item');
  const panels = document.querySelectorAll('.settings-panel');

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const panelId = item.dataset.settings;
      navItems.forEach((el) => el.classList.toggle('active', el === item));
      panels.forEach((panel) => {
        panel.classList.toggle('active', panel.id === `settings-${panelId}`);
      });
    });
  });
}

function renderUser(user) {
  const nameEl = document.getElementById('account-name');
  const emailEl = document.getElementById('account-email');
  const avatarEl = document.getElementById('account-avatar');
  const fallbackEl = document.getElementById('account-avatar-fallback');
  const greetingEl = document.getElementById('home-greeting');

  if (!user) return;

  const firstName = user.name?.split(/\s+/)[0] || 'there';
  if (greetingEl) greetingEl.textContent = `Welcome back, ${firstName}`;
  if (nameEl) nameEl.textContent = user.name || '—';
  if (emailEl) emailEl.textContent = user.email || '—';

  if (user.picture && avatarEl && fallbackEl) {
    avatarEl.src = user.picture;
    avatarEl.hidden = false;
    fallbackEl.hidden = true;
  } else if (fallbackEl) {
    fallbackEl.textContent = initials(user.name);
  }
}

function applySettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };

  const glassesName = document.getElementById('setting-glasses-name');
  const museAuto = document.getElementById('setting-muse-auto');
  const museRate = document.getElementById('setting-muse-rate');
  const cameraAuto = document.getElementById('setting-camera-auto');
  const cameraRes = document.getElementById('setting-camera-res');

  if (glassesName) glassesName.value = merged.glassesName;
  if (museAuto) museAuto.checked = merged.museAutoConnect;
  if (museRate) museRate.value = String(merged.museSampleRate);
  if (cameraAuto) cameraAuto.checked = merged.cameraAutoStart;
  if (cameraRes) cameraRes.value = merged.cameraResolution;

  const homeGlasses = document.getElementById('home-glasses-status');
  if (homeGlasses) homeGlasses.textContent = 'Not connected';
}

function parseCameraResolution(value) {
  const [width, height] = String(value || DEFAULT_SETTINGS.cameraResolution)
    .split('x')
    .map(Number);
  return {
    width: Number.isFinite(width) ? width : 1280,
    height: Number.isFinite(height) ? height : 720,
  };
}

function setCameraStatus(active, message) {
  const pill = document.getElementById('hw-camera-pill');
  const home = document.getElementById('home-camera-status');

  if (pill) {
    pill.textContent = active ? 'Live' : 'Off';
    pill.classList.toggle('online', active);
    pill.classList.toggle('offline', !active);
  }
  if (home) {
    home.textContent = active ? 'Live' : 'Off';
  }

  const wrap = document.querySelector('.camera-preview-wrap');
  if (wrap) wrap.classList.toggle('streaming', active);

  const hint = document.getElementById('camera-preview-hint');
  if (hint) {
    hint.textContent = message || '';
    hint.classList.toggle('error', Boolean(message && !active));
  }
}

async function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }

  const video = document.getElementById('camera-preview');
  if (video) video.srcObject = null;

  setCameraStatus(false);
}

async function startCamera(resolutionValue) {
  if (cameraStarting) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraStatus(false, 'Camera API is not available in this environment.');
    return;
  }

  cameraStarting = true;
  const { width, height } = parseCameraResolution(resolutionValue);

  try {
    await stopCamera();

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: width },
        height: { ideal: height },
      },
      audio: false,
    });

    const video = document.getElementById('camera-preview');
    if (video) {
      video.srcObject = cameraStream;
      await video.play();
    }

    const track = cameraStream.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};
    const actual = settings.width && settings.height
      ? `${settings.width}×${settings.height}`
      : `${width}×${height}`;
    setCameraStatus(true, `Streaming at ${actual}`);
  } catch (err) {
    await stopCamera();
    const msg =
      err.name === 'NotAllowedError'
        ? 'Camera permission denied. Allow access in System Settings.'
        : err.message || 'Could not start camera.';
    setCameraStatus(false, msg);
  } finally {
    cameraStarting = false;
  }
}

function bindCameraControls() {
  const save = (partial) => window.glass.setSettings(partial);

  document.getElementById('camera-start-btn')?.addEventListener('click', async () => {
    const res = document.getElementById('setting-camera-res')?.value;
    await startCamera(res);
  });

  document.getElementById('camera-stop-btn')?.addEventListener('click', () => {
    stopCamera();
  });

  document.getElementById('setting-camera-res')?.addEventListener('change', async (e) => {
    save({ cameraResolution: e.target.value });
    if (cameraStream) {
      await startCamera(e.target.value);
    }
  });

  document.getElementById('setting-camera-auto')?.addEventListener('change', async (e) => {
    save({ cameraAutoStart: e.target.checked });
    if (e.target.checked) {
      const res = document.getElementById('setting-camera-res')?.value;
      await startCamera(res);
    } else {
      stopCamera();
    }
  });

  window.addEventListener('beforeunload', () => {
    stopVisionSpeech();
    stopCamera();
  });
}

function captureCameraFrame() {
  const video = document.getElementById('camera-preview');
  if (!video || !cameraStream || video.videoWidth === 0 || video.videoHeight === 0) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.88);
}

function setVisionUi({ state, imageDataUrl, prompt, hint, analysis, hintIsError = false }) {
  if (state !== undefined) visionUiCache.state = state;
  if (imageDataUrl !== undefined) visionUiCache.imageDataUrl = imageDataUrl;
  if (prompt !== undefined) visionUiCache.prompt = prompt;
  if (hint !== undefined) visionUiCache.hint = hint;
  if (analysis !== undefined) visionUiCache.analysis = analysis;

  const view = {
    ...visionUiCache,
    hintIsError,
  };

  const panel = document.getElementById('vision-panel');
  const pill = document.getElementById('vision-state-pill');
  const img = document.getElementById('vision-capture-img');
  const wrap = document.querySelector('.vision-capture-wrap');
  const promptEl = document.getElementById('vision-prompt');
  const hintEl = document.getElementById('vision-hint');
  const analysisEl = document.getElementById('vision-analysis');

  if (panel) {
    if (view.state !== 'idle' || view.imageDataUrl || view.analysis) {
      panel.hidden = false;
    }
  }

  if (pill) {
    const labels = {
      idle: 'Idle',
      confirm: 'Awaiting reply',
      analyzing: 'Analyzing…',
      speaking: 'Speaking…',
      done: 'Complete',
      error: 'Error',
    };
    pill.textContent = labels[view.state] || 'Idle';
    pill.classList.toggle('online', view.state === 'done' || view.state === 'analyzing' || view.state === 'speaking');
    pill.classList.toggle('offline', view.state === 'idle' || view.state === 'error');
    pill.classList.toggle('connecting', view.state === 'confirm' || view.state === 'analyzing' || view.state === 'speaking');
  }

  if (img && wrap && view.imageDataUrl) {
    img.src = view.imageDataUrl;
    img.hidden = false;
    wrap.classList.add('has-image');
  }

  if (promptEl) {
    promptEl.textContent = view.prompt;
    promptEl.classList.toggle('confirm', view.state === 'confirm');
  }

  if (hintEl) {
    hintEl.textContent = view.hint;
    hintEl.classList.toggle('error', hintIsError);
  }

  if (analysisEl) {
    if (view.analysis) {
      analysisEl.hidden = false;
      analysisEl.textContent = view.analysis;
      analysisEl.classList.toggle('loading', view.state === 'analyzing');
    } else if (view.state === 'analyzing') {
      analysisEl.hidden = false;
      analysisEl.textContent = 'Sending to GPT-4o for analysis…';
      analysisEl.classList.add('loading');
    } else {
      analysisEl.hidden = true;
      analysisEl.textContent = '';
      analysisEl.classList.remove('loading');
    }
  }
}

async function ensureCameraForCapture() {
  if (cameraStream) return true;
  const res =
    document.getElementById('setting-camera-res')?.value || DEFAULT_SETTINGS.cameraResolution;
  await startCamera(res);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return Boolean(cameraStream);
}

function isVisionInputLocked() {
  return visionState === 'analyzing' || visionState === 'speaking';
}

function finishVisionSpeech() {
  stopVisionSpeech();
  if (visionState !== 'speaking') return;
  visionState = 'idle';
  setVisionUi({
    state: 'idle',
    hint: 'Jaw click to capture a new frame.',
  });
}

function stopVisionSpeech() {
  if (visionSpeechAudio) {
    visionSpeechAudio.pause();
    visionSpeechAudio.src = '';
    visionSpeechAudio = null;
  }
  if (visionSpeechObjectUrl) {
    URL.revokeObjectURL(visionSpeechObjectUrl);
    visionSpeechObjectUrl = null;
  }
}

async function announceVisionResult(text) {
  if (!text?.trim()) {
    if (visionState === 'speaking') finishVisionSpeech();
    return false;
  }

  stopVisionSpeech();
  visionState = 'speaking';
  setVisionUi({ state: 'speaking', hint: 'Preparing speech…' });

  const result = await window.glass.speakTts(text);
  if (!result?.success || !result.audioBase64) {
    console.warn('TTS failed:', result?.error);
    visionState = 'done';
    setVisionUi({
      state: 'done',
      hint: result?.error || 'Speech failed. Check your Inworld API key in .env.',
      hintIsError: true,
    });
    return false;
  }

  setVisionUi({ hint: 'Assistant speaking…' });

  const binary = atob(result.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: result.contentType || 'audio/mpeg' });
  visionSpeechObjectUrl = URL.createObjectURL(blob);
  visionSpeechAudio = new Audio(visionSpeechObjectUrl);
  visionSpeechAudio.onended = () => finishVisionSpeech();
  visionSpeechAudio.onerror = () => {
    visionState = 'done';
    setVisionUi({
      state: 'done',
      hint: 'Could not play audio. Check system volume.',
      hintIsError: true,
    });
    stopVisionSpeech();
  };

  try {
    await visionSpeechAudio.play();
    return true;
  } catch (err) {
    console.warn('Audio playback failed:', err);
    visionState = 'done';
    setVisionUi({
      state: 'done',
      hint: 'Could not play audio. Check system volume and permissions.',
      hintIsError: true,
    });
    stopVisionSpeech();
    return false;
  }
}

async function onJawClickCapture() {
  if (isVisionInputLocked()) return;

  stopVisionSpeech();
  switchToHomeView();

  const ready = await ensureCameraForCapture();
  const frame = captureCameraFrame();

  if (!ready || !frame) {
    visionState = 'error';
    setVisionUi({
      state: 'error',
      prompt: 'Could not capture a camera frame.',
      hint: 'Start the camera in Settings → Hardware, then jaw click again.',
      hintIsError: true,
    });
    return;
  }

  pendingVisionImage = frame;
  visionState = 'confirm';

  setVisionUi({
    state: 'confirm',
    imageDataUrl: frame,
    prompt: 'Analyze this image?',
    hint: 'Nod your head for yes · shake for no',
    analysis: null,
  });
}

function cancelVisionConfirm() {
  stopVisionSpeech();
  const img = document.getElementById('vision-capture-img');
  const frame = img?.src?.startsWith('data:') ? img.src : pendingVisionImage;
  visionState = 'idle';
  pendingVisionImage = null;
  setVisionUi({
    state: 'idle',
    imageDataUrl: frame || undefined,
    prompt: 'Analysis cancelled.',
    hint: 'Jaw click to capture another frame.',
    analysis: null,
  });
}

async function submitVisionAnalysis() {
  if (!pendingVisionImage || visionState !== 'confirm') return;

  visionState = 'analyzing';
  setVisionUi({
    state: 'analyzing',
    imageDataUrl: pendingVisionImage,
    prompt: 'Analyzing capture…',
    hint: '',
    analysis: 'Sending to GPT-4o for analysis…',
  });

  const result = await window.glass.analyzeVision(pendingVisionImage);

  if (result.success) {
    visionState = 'speaking';
    setVisionUi({
      state: 'speaking',
      imageDataUrl: pendingVisionImage,
      prompt: 'Analysis complete',
      hint: 'Assistant speaking…',
      analysis: result.analysis,
    });
    await announceVisionResult(result.analysis);
  } else {
    visionState = 'error';
    setVisionUi({
      state: 'error',
      imageDataUrl: pendingVisionImage,
      prompt: 'Analysis failed',
      hint: result.error || 'Unknown error',
      hintIsError: true,
      analysis: null,
    });
  }

  pendingVisionImage = null;
}

function handleVisionHeadGesture(gesture) {
  if (visionState !== 'confirm') return;

  if (gesture === 'yes') {
    submitVisionAnalysis();
  } else if (gesture === 'no') {
    cancelVisionConfirm();
  }
}

function museStateLabel(state) {
  switch (state) {
    case 'streaming':
      return 'Streaming';
    case 'connected':
      return 'Connected';
    case 'connecting':
    case 'scanning':
      return 'Connecting…';
    case 'ready':
      return 'Ready';
    case 'error':
      return 'Error';
    default:
      return 'Offline';
  }
}

function updateMusePills(state) {
  const streaming = STREAMING_STATES.has(state);
  const pill = document.getElementById('hw-muse-pill');
  const home = document.getElementById('home-muse-status');

  if (pill) {
    pill.textContent = museStateLabel(state);
    pill.classList.toggle('online', streaming);
    pill.classList.toggle('offline', !streaming);
    pill.classList.toggle('connecting', state === 'connecting' || state === 'scanning');
  }

  if (home) {
    home.textContent = museStateLabel(state);
  }
}

function updateEegBars(eeg) {
  const bars = document.querySelectorAll('#muse-eeg-bars .eeg-bar');
  const valuesEl = document.getElementById('muse-eeg-values');
  if (!Array.isArray(eeg) || eeg.length < 4) return;

  const maxAbs = Math.max(...eeg.map((v) => Math.abs(v)), 1);

  bars.forEach((bar, idx) => {
    const height = Math.min(100, (Math.abs(eeg[idx]) / maxAbs) * 100);
    bar.style.height = `${Math.max(8, height)}%`;
  });

  if (valuesEl) {
    valuesEl.innerHTML = EEG_LABELS.map(
      (label, idx) => `<span>${label} ${Number(eeg[idx]).toFixed(1)} µV</span>`
    ).join('');
  }
}

function updateImuAxisBars(containerId, valuesId, values, range, unit) {
  const container = document.getElementById(containerId);
  const valuesEl = document.getElementById(valuesId);
  if (!container || !Array.isArray(values) || values.length < 3) return;

  container.querySelectorAll('.imu-axis-row').forEach((row, idx) => {
    const value = Number(values[idx]);
    const clamped = Math.max(-range, Math.min(range, value));
    const pct = (Math.abs(clamped) / range) * 50;
    const fill = row.querySelector('.imu-axis-fill');
    if (!fill) return;

    if (clamped >= 0) {
      fill.style.left = '50%';
      fill.style.right = 'auto';
      fill.style.width = `${pct}%`;
    } else {
      fill.style.left = 'auto';
      fill.style.right = '50%';
      fill.style.width = `${pct}%`;
    }
  });

  if (valuesEl) {
    valuesEl.innerHTML = IMU_AXIS_LABELS.map(
      (label, idx) => `<span>${label} ${Number(values[idx]).toFixed(3)} ${unit}</span>`
    ).join('');
  }
}

function updateImuViz(muse) {
  if (Array.isArray(muse.acc)) {
    updateImuAxisBars('imu-acc-bars', 'imu-acc-values', muse.acc, IMU_ACC_RANGE, 'g');
  }
  if (Array.isArray(muse.gyro)) {
    updateImuAxisBars('imu-gyro-bars', 'imu-gyro-values', muse.gyro, IMU_GYRO_RANGE, '°/s');
  }
}

function updateHeadGestureUi(muse) {
  const statusEl = document.getElementById('head-gesture-status');
  const nodEl = document.getElementById('nod-count');
  const shakeEl = document.getElementById('shake-count');
  const yLevel = document.getElementById('head-y-level');
  const zLevel = document.getElementById('head-z-level');

  if (statusEl && muse.head_gesture_status) {
    statusEl.textContent = muse.head_gesture_status;
  }
  if (nodEl) nodEl.textContent = String(muse.nod_count ?? 0);
  if (shakeEl) shakeEl.textContent = String(muse.shake_count ?? 0);

  const yThr = muse.yes_threshold_y ?? 30;
  const zThr = muse.no_threshold_z ?? 80;
  const yPeak = muse.peak_y_gyro ?? 0;
  const zPeak = muse.peak_z_gyro ?? 0;

  if (yLevel) {
    yLevel.textContent = `Y peak ${yPeak.toFixed(0)} / ${yThr.toFixed(0)} °/s`;
    yLevel.classList.toggle('at-threshold', yPeak >= yThr);
  }
  if (zLevel) {
    zLevel.textContent = `Z peak ${zPeak.toFixed(0)} / ${zThr.toFixed(0)} °/s`;
    zLevel.classList.toggle('at-threshold', zPeak >= zThr);
  }
}

function flashHeadGesture(gesture) {
  const yesBox = document.getElementById('gesture-yes-box');
  const noBox = document.getElementById('gesture-no-box');
  if (!yesBox || !noBox) return;

  const target = gesture === 'yes' ? yesBox : noBox;
  const cls = gesture === 'yes' ? 'flash-yes' : 'flash-no';
  target.classList.add(cls);
  if (gestureFlashTimer) clearTimeout(gestureFlashTimer);
  gestureFlashTimer = setTimeout(() => {
    yesBox.classList.remove('flash-yes');
    noBox.classList.remove('flash-no');
  }, 320);
}

function updateJawUi(muse) {
  const statusEl = document.getElementById('muse-jaw-status');
  const countEl = document.getElementById('muse-click-count');
  const scoreEl = document.getElementById('muse-jaw-score');
  const calPill = document.getElementById('muse-calibration-pill');
  const hintEl = document.getElementById('muse-status-hint');

  if (statusEl && muse.status) statusEl.textContent = muse.status;
  if (countEl) countEl.textContent = String(muse.click_count ?? 0);
  if (scoreEl) {
    const score = muse.jaw_score;
    const thr = muse.threshold;
    if (typeof score === 'number' && typeof thr === 'number' && thr > 0) {
      scoreEl.textContent = `${score.toFixed(2)} / ${thr.toFixed(2)}`;
    } else if (typeof score === 'number') {
      scoreEl.textContent = score.toFixed(2);
    } else {
      scoreEl.textContent = '—';
    }
  }
  if (hintEl && muse.message) hintEl.textContent = muse.message;

  if (calPill) {
    const phase = muse.calibration_phase;
    if (phase === 'baseline' || phase === 'clench') {
      calPill.textContent = 'Calibrating…';
      calPill.className = 'status-pill calibrating';
    } else if (muse.calibrated) {
      calPill.textContent = 'Calibrated';
      calPill.className = 'status-pill calibrated';
    } else {
      calPill.textContent = 'Not calibrated';
      calPill.className = 'status-pill offline';
    }
  }
}

function flashJawTestBox() {
  const box = document.getElementById('jaw-test-box');
  if (!box) return;
  box.classList.add('flash');
  if (jawFlashTimer) clearTimeout(jawFlashTimer);
  jawFlashTimer = setTimeout(() => box.classList.remove('flash'), 280);
}

function updateDeviceList(devices) {
  const row = document.getElementById('muse-device-row');
  const select = document.getElementById('muse-device-select');
  if (!select || !row) return;

  if (!devices?.length) {
    row.hidden = true;
    select.innerHTML = '';
    return;
  }

  row.hidden = false;
  select.innerHTML = devices
    .map(
      (device) =>
        `<option value="${device.address}">${device.name || 'Muse'} (${device.address})</option>`
    )
    .join('');
}

function applyMuseState(muse) {
  if (!muse) return;
  updateMusePills(muse.state);
  updateEegBars(muse.eeg);
  updateImuViz(muse);
  updateHeadGestureUi(muse);
  updateJawUi(muse);
  updateDeviceList(muse.devices);
}

function bindMuseControls() {
  document.getElementById('muse-scan-btn')?.addEventListener('click', () => {
    window.glass.museScan();
  });

  document.getElementById('muse-connect-btn')?.addEventListener('click', async () => {
    const select = document.getElementById('muse-device-select');
    if (select?.value) {
      const option = select.selectedOptions[0];
      await window.glass.museConnect({
        address: select.value,
        name: option?.textContent?.split(' (')[0] || 'Muse',
      });
      return;
    }
    await window.glass.museConnectAuto();
  });

  document.getElementById('muse-disconnect-btn')?.addEventListener('click', () => {
    window.glass.museDisconnect();
  });

  document.getElementById('muse-calibrate-btn')?.addEventListener('click', () => {
    window.glass.museCalibrate();
  });

  window.glass.onMuseEvent((event) => {
    if (event.museState) {
      applyMuseState(event.museState);
    }
    if (event.type === 'jaw_click') {
      flashJawTestBox();
      if (!isVisionInputLocked()) {
        onJawClickCapture();
      }
    }
    if (event.type === 'head_gesture') {
      if (visionState === 'confirm') {
        handleVisionHeadGesture(event.gesture);
      } else {
        flashHeadGesture(event.gesture);
      }
    }
  });
}

function bindSettingsControls() {
  const save = (partial) => window.glass.setSettings(partial);

  document.getElementById('setting-glasses-name')?.addEventListener('change', (e) => {
    save({ glassesName: e.target.value.trim() || DEFAULT_SETTINGS.glassesName });
  });

  document.getElementById('setting-muse-auto')?.addEventListener('change', (e) => {
    save({ museAutoConnect: e.target.checked });
  });

  document.getElementById('setting-muse-rate')?.addEventListener('change', (e) => {
    save({ museSampleRate: Number(e.target.value) });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  bindViewNav();
  bindSettingsNav();
  bindSettingsControls();
  bindMuseControls();
  bindCameraControls();

  const user = await window.glass.getUser();
  if (!user) {
    window.location.href = 'login.html';
    return;
  }

  renderUser(user);

  const settings = await window.glass.getSettings();
  applySettings(settings);

  const museState = await window.glass.museGetState();
  applyMuseState(museState);

  if (settings.museAutoConnect) {
    window.glass.museConnectAuto();
  }

  if (settings.cameraAutoStart) {
    startCamera(settings.cameraResolution);
  }

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await window.glass.logout();
  });
});

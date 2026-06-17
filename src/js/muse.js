const CONNECTING_STATES = new Set([
  'scanning',
  'connecting',
  'connected',
  'waiting_stream',
  'ready',
  'disconnected',
]);

const CONNECTED_STATES = new Set(['streaming', 'connected']);

const STATE_CLASSES = [
  'idle',
  'scanning',
  'ready',
  'connecting',
  'connected',
  'waiting_stream',
  'streaming',
  'disconnected',
  'error',
];

const EEG_CHANNELS = [
  { id: 'eeg-tp9', index: 0 },
  { id: 'eeg-af7', index: 1 },
  { id: 'eeg-af8', index: 2 },
  { id: 'eeg-tp10', index: 3 },
];

function uiState(raw) {
  if (CONNECTED_STATES.has(raw)) return 'connected';
  if (CONNECTING_STATES.has(raw)) return 'connecting';
  if (raw === 'error') return 'error';
  return 'idle';
}

function summaryLabel(raw) {
  if (raw === 'streaming' || raw === 'connected') return 'Connected';
  if (CONNECTING_STATES.has(raw)) return 'Connecting…';
  if (raw === 'error') return 'Connection failed';
  return 'Not connected';
}

function formatEeg(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toFixed(1);
}

function setEegValues(eeg) {
  if (!Array.isArray(eeg) || eeg.length < 4) return false;

  for (const { id, index } of EEG_CHANNELS) {
    const el = document.getElementById(id);
    if (el) el.textContent = formatEeg(eeg[index]);
  }

  const waiting = document.getElementById('muse-eeg-waiting');
  if (waiting) waiting.hidden = true;

  const streamPreview = document.getElementById('muse-stream-preview');
  if (streamPreview) streamPreview.hidden = false;

  return true;
}

function clearEegValues() {
  for (const { id } of EEG_CHANNELS) {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  }

  const waiting = document.getElementById('muse-eeg-waiting');
  if (waiting) waiting.hidden = false;
}

function applyStatus(status) {
  const raw = status.state || 'idle';
  const ui = uiState(raw);
  const label = summaryLabel(raw);

  const mainState = document.getElementById('muse-main-state');
  const mainMessage = document.getElementById('muse-main-message');
  if (mainState) mainState.textContent = label;
  if (mainMessage) mainMessage.textContent = status.message || '';

  const summaryDot = document.getElementById('muse-main-dot');
  if (summaryDot) {
    summaryDot.classList.remove(...STATE_CLASSES);
    summaryDot.classList.add(
      ui === 'connected' ? 'streaming' : ui === 'connecting' ? 'connecting' : raw
    );
  }

  const title = document.getElementById('muse-connect-title');
  const subtitle = document.getElementById('muse-connect-subtitle');
  const connectBtn = document.getElementById('muse-connect-btn');
  const deviceLine = document.getElementById('muse-device-name');
  const card = document.querySelector('.muse-connect-card');
  const streamPreview = document.getElementById('muse-stream-preview');
  const setupHint = document.getElementById('muse-setup-hint');

  if (setupHint) setupHint.hidden = status.bridgeInstalled !== false;

  if (card) {
    card.classList.remove('idle', 'connecting', 'connected', 'error');
    card.classList.add(ui);
  }

  if (title) {
    title.textContent =
      status.device?.name || (ui === 'connected' ? 'Muse Headset' : 'Muse Headset');
  }

  if (subtitle) {
    if (ui === 'connected') {
      subtitle.textContent = status.message || 'Headband connected and streaming.';
    } else if (ui === 'connecting') {
      subtitle.textContent = status.message || 'Setting up your headband…';
    } else if (ui === 'error') {
      subtitle.textContent = status.message || 'Something went wrong. Tap Connect to try again.';
    } else {
      subtitle.textContent =
        'Tap Connect — glass-1 finds and pairs your headband automatically.';
    }
  }

  if (connectBtn) {
    if (ui === 'connected') {
      connectBtn.textContent = 'Disconnect';
      connectBtn.disabled = false;
      connectBtn.dataset.mode = 'disconnect';
    } else if (ui === 'connecting') {
      connectBtn.textContent = 'Connecting…';
      connectBtn.disabled = true;
      connectBtn.dataset.mode = 'connecting';
    } else {
      connectBtn.textContent = 'Connect';
      connectBtn.disabled = false;
      connectBtn.dataset.mode = 'connect';
    }
  }

  if (deviceLine) {
    if (ui === 'connected' && status.device) {
      deviceLine.textContent = status.device.name;
      deviceLine.hidden = false;
    } else {
      deviceLine.hidden = true;
    }
  }

  const hasEeg = status.lastEeg ? setEegValues(status.lastEeg) : false;

  if (streamPreview) {
    streamPreview.hidden = !(
      hasEeg || raw === 'streaming' || raw === 'connected' || raw === 'waiting_stream'
    );
  }

  if (raw === 'idle' || raw === 'error') {
    clearEegValues();
    if (streamPreview) streamPreview.hidden = true;
  } else if (
    !hasEeg &&
    (raw === 'streaming' || raw === 'connected' || raw === 'waiting_stream')
  ) {
    const waiting = document.getElementById('muse-eeg-waiting');
    if (waiting) waiting.hidden = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  if (!window.muse) return;

  const status = await window.muse.getStatus();
  if (status) applyStatus(status);

  window.muse.onStatus(applyStatus);
  window.muse.onEeg((eeg) => setEegValues(eeg));

  document.getElementById('muse-connect-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('muse-connect-btn');
    if (btn?.dataset.mode === 'disconnect') {
      await window.muse.disconnect();
      return;
    }
    const result = await window.muse.connect();
    if (!result.success && result.error) {
      applyStatus({
        state: 'error',
        message: result.error,
        bridgeInstalled: true,
      });
    }
  });
});

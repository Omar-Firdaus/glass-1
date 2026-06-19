const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BRIDGE_SCRIPT = path.join(__dirname, '../muse/bridge.py');
const VENV_PYTHON = path.join(__dirname, '../muse/.venv/bin/python3');

let museProcess = null;
let museState = {
  state: 'idle',
  message: 'Muse bridge not started',
  device: null,
  devices: [],
  eeg: [0, 0, 0, 0],
  acc: null,
  gyro: null,
  nod_count: 0,
  shake_count: 0,
  last_head_gesture: null,
  head_gesture_status: 'Nod yes when gyro Y ≥ 30 °/s · shake no when gyro Z ≥ 80 °/s.',
  yes_threshold_y: 30,
  no_threshold_z: 80,
  peak_y_gyro: 0,
  peak_z_gyro: 0,
  calibrated: false,
  click_count: 0,
  status: 'Jaw click: not calibrated. Press Calibrate.',
  calibration_phase: 'idle',
};

function getPythonPath() {
  if (fs.existsSync(VENV_PYTHON)) return VENV_PYTHON;
  return 'python3';
}

function broadcast(channel, payload) {
  const { BrowserWindow } = require('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function handleBridgeMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'status':
      museState.state = msg.state || museState.state;
      museState.message = msg.message || museState.message;
      if (msg.device !== undefined) museState.device = msg.device;
      if (msg.devices !== undefined) museState.devices = msg.devices;
      break;
    case 'devices':
      museState.devices = msg.devices || [];
      break;
    case 'telemetry':
      if (Array.isArray(msg.eeg)) museState.eeg = msg.eeg;
      if (Array.isArray(msg.acc)) museState.acc = msg.acc;
      if (Array.isArray(msg.gyro)) museState.gyro = msg.gyro;
      if (msg.calibrated !== undefined) museState.calibrated = msg.calibrated;
      if (msg.click_count !== undefined) museState.click_count = msg.click_count;
      if (msg.status !== undefined) museState.status = msg.status;
      if (msg.threshold !== undefined) museState.threshold = msg.threshold;
      if (msg.jaw_score !== undefined) museState.jaw_score = msg.jaw_score;
      if (msg.nod_count !== undefined) museState.nod_count = msg.nod_count;
      if (msg.shake_count !== undefined) museState.shake_count = msg.shake_count;
      if (msg.last_head_gesture !== undefined) {
        museState.last_head_gesture = msg.last_head_gesture;
      }
      if (msg.head_gesture_status !== undefined) {
        museState.head_gesture_status = msg.head_gesture_status;
      }
      if (msg.yes_threshold_y !== undefined) museState.yes_threshold_y = msg.yes_threshold_y;
      if (msg.no_threshold_z !== undefined) museState.no_threshold_z = msg.no_threshold_z;
      if (msg.peak_y_gyro !== undefined) museState.peak_y_gyro = msg.peak_y_gyro;
      if (msg.peak_z_gyro !== undefined) museState.peak_z_gyro = msg.peak_z_gyro;
      if (msg.calibration_phase !== undefined) {
        museState.calibration_phase = msg.calibration_phase;
      }
      if (msg.device !== undefined) museState.device = msg.device;
      break;
    case 'imu':
      if (Array.isArray(msg.acc)) museState.acc = msg.acc;
      if (Array.isArray(msg.gyro)) museState.gyro = msg.gyro;
      if (msg.nod_count !== undefined) museState.nod_count = msg.nod_count;
      if (msg.shake_count !== undefined) museState.shake_count = msg.shake_count;
      if (msg.head_gesture_status !== undefined) {
        museState.head_gesture_status = msg.head_gesture_status;
      }
      if (msg.peak_y_gyro !== undefined) museState.peak_y_gyro = msg.peak_y_gyro;
      if (msg.peak_z_gyro !== undefined) museState.peak_z_gyro = msg.peak_z_gyro;
      if (msg.device !== undefined) museState.device = msg.device;
      break;
    case 'head_gesture':
      if (msg.gesture !== undefined) museState.last_head_gesture = msg.gesture;
      if (msg.nod_count !== undefined) museState.nod_count = msg.nod_count;
      if (msg.shake_count !== undefined) museState.shake_count = msg.shake_count;
      if (msg.status !== undefined) museState.head_gesture_status = msg.status;
      break;
    case 'jaw_click':
      if (msg.click_count !== undefined) museState.click_count = msg.click_count;
      if (msg.status !== undefined) museState.status = msg.status;
      break;
    case 'calibration':
      if (msg.calibrated !== undefined) museState.calibrated = msg.calibrated;
      if (msg.status !== undefined) museState.status = msg.status;
      if (msg.phase !== undefined) museState.calibration_phase = msg.phase;
      break;
    case 'error':
      museState.message = msg.message || museState.message;
      break;
    default:
      break;
  }

  broadcast('muse:event', { ...msg, museState: { ...museState } });
}

function sendCommand(command) {
  if (!museProcess || museProcess.killed) {
    return { ok: false, error: 'Muse bridge is not running' };
  }
  try {
    museProcess.stdin.write(`${JSON.stringify(command)}\n`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function startMuseBridge() {
  if (museProcess && !museProcess.killed) return;

  const python = getPythonPath();
  museProcess = spawn(python, [BRIDGE_SCRIPT], {
    cwd: path.join(__dirname, '../muse'),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });

  let buffer = '';

  museProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleBridgeMessage(JSON.parse(trimmed));
      } catch {
        // Non-JSON output should not reach stdout; ignore parse errors.
      }
    }
  });

  museProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      console.error('[muse-bridge]', text);
    }
  });

  museProcess.on('exit', (code) => {
    museProcess = null;
    museState.state = 'idle';
    museState.message = code === 0 ? 'Muse bridge stopped' : `Muse bridge exited (${code})`;
    broadcast('muse:event', {
      type: 'status',
      state: 'idle',
      message: museState.message,
      museState: { ...museState },
    });
  });
}

function stopMuseBridge() {
  if (!museProcess || museProcess.killed) return;
  sendCommand({ command: 'stop' });
  setTimeout(() => {
    if (museProcess && !museProcess.killed) {
      museProcess.kill();
    }
  }, 500);
}

function registerMuseIpc(ipcMain, store) {
  ipcMain.handle('muse:get-state', () => ({ ...museState }));

  ipcMain.handle('muse:scan', () => {
    startMuseBridge();
    return sendCommand({ command: 'scan' });
  });

  ipcMain.handle('muse:connect', (_event, device) => {
    startMuseBridge();
    if (device?.address) {
      store.set('museLastAddress', device.address);
    }
    return sendCommand({
      command: 'connect',
      address: device?.address,
      name: device?.name,
    });
  });

  ipcMain.handle('muse:connect-auto', () => {
    startMuseBridge();
    const lastAddress = store.get('museLastAddress');
    return sendCommand({ command: 'connect_auto', lastAddress });
  });

  ipcMain.handle('muse:disconnect', () => sendCommand({ command: 'disconnect' }));

  ipcMain.handle('muse:calibrate', () => sendCommand({ command: 'calibrate' }));
}

module.exports = {
  startMuseBridge,
  stopMuseBridge,
  registerMuseIpc,
};

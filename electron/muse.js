const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BRIDGE_SCRIPT = path.join(__dirname, '../muse/bridge.py');
const VENV_PYTHON = path.join(__dirname, '../muse/.venv/bin/python3');

const DEFAULT_STATE = {
  state: 'idle',
  message: 'Not connected',
  devices: [],
  device: null,
  error: null,
  lastEeg: null,
  bridgeReady: false,
};

class MuseManager {
  constructor(store, getMainWindow) {
    this.store = store;
    this.getMainWindow = getMainWindow;
    this.process = null;
    this.state = { ...DEFAULT_STATE };
    this._starting = false;
    this._buffer = '';
  }

  getPythonPath() {
    if (fs.existsSync(VENV_PYTHON)) return VENV_PYTHON;
    return 'python3';
  }

  isBridgeInstalled() {
    return fs.existsSync(VENV_PYTHON);
  }

  getStatus() {
    return { ...this.state, bridgeInstalled: this.isBridgeInstalled() };
  }

  broadcast() {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('muse:status', this.getStatus());
    }
  }

  broadcastEeg(eeg) {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('muse:eeg', eeg);
    }
  }

  updateState(partial) {
    this.state = { ...this.state, ...partial };
    this.broadcast();
  }

  ensureBridge() {
    if (this.process) return Promise.resolve();
    if (this._starting) {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (this.process && this.state.bridgeReady) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
    }

    this._starting = true;

    return new Promise((resolve, reject) => {
      if (!fs.existsSync(BRIDGE_SCRIPT)) {
        this._starting = false;
        reject(new Error('Muse bridge script not found'));
        return;
      }

      const python = this.getPythonPath();
      this.process = spawn(python, [BRIDGE_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      const readyTimeout = setTimeout(() => {
        this._starting = false;
        if (this.state.bridgeReady) {
          resolve();
        } else {
          this.updateState({
            state: 'error',
            message:
              'Muse bridge did not start. Run ./scripts/setup-muse.sh first.',
          });
          resolve();
        }
      }, 4000);

      const markReady = () => {
        if (!this._starting) return;
        clearTimeout(readyTimeout);
        this._starting = false;
        resolve();
      };

      this.process.stdout.on('data', (chunk) => {
        this._buffer += chunk.toString();
        const lines = this._buffer.split('\n');
        this._buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            const wasReady = this.state.bridgeReady;
            this._handleLine(line.trim());
            if (!wasReady && this.state.bridgeReady) markReady();
          }
        }
      });

      this.process.stderr.on('data', (chunk) => {
        console.error('[muse-bridge]', chunk.toString());
      });

      this.process.on('error', (err) => {
        clearTimeout(readyTimeout);
        this.process = null;
        this._starting = false;
        this.updateState({
          state: 'error',
          error: err.message,
          message: `Bridge failed to start: ${err.message}`,
          bridgeReady: false,
        });
        reject(err);
      });

      this.process.on('exit', (code) => {
        clearTimeout(readyTimeout);
        this.process = null;
        this._starting = false;
        if (code !== 0 && code !== null && this.state.state !== 'error') {
          this.updateState({
            state: 'error',
            bridgeReady: false,
            message:
              this.state.message ||
              'Muse bridge exited unexpectedly. Run npm run setup:muse and restart.',
          });
        }
      });
    });
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === 'status') {
      const next = {
        state: msg.state,
        message: msg.message || '',
        error: msg.state === 'error' ? msg.message : null,
        bridgeReady: true,
      };
      if (msg.devices) next.devices = msg.devices;
      if (msg.device) next.device = msg.device;
      if (msg.state === 'idle' && !msg.device) next.device = null;
      if (msg.state === 'streaming' && msg.device) {
        this.store.set('muse:lastDevice', msg.device);
      }
      if (msg.state === 'connected' && msg.device) {
        this.store.set('muse:lastDevice', msg.device);
      }
      this.updateState(next);
      return;
    }

    if (msg.type === 'devices') {
      this.updateState({ devices: msg.devices || [] });
      return;
    }

    if (msg.type === 'telemetry') {
      this.state.lastEeg = msg.eeg;
      this.state.state = 'streaming';
      if (msg.device) this.state.device = msg.device;
      this.state.message = this.state.device
        ? `Connected — live EEG from ${this.state.device.name}`
        : 'Connected — live EEG streaming';
      this.broadcastEeg(msg.eeg);
      return;
    }

    if (msg.type === 'error') {
      this.updateState({
        state: 'error',
        error: msg.message,
        message: msg.message,
      });
    }
  }

  send(command) {
    if (!this.process?.stdin.writable) {
      throw new Error('Muse bridge is not running');
    }
    this.process.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async connectAuto() {
    await this.ensureBridge();
    const last = this.store.get('muse:lastDevice');
    this.updateState({
      state: 'connecting',
      message: 'Looking for your Muse…',
      device: last || null,
      error: null,
    });
    this.send({
      command: 'connect_auto',
      lastAddress: last?.address || null,
      lastName: last?.name || null,
    });
    return this.getStatus();
  }

  isConnected() {
    return ['streaming', 'connected', 'connecting', 'waiting_stream', 'scanning'].includes(
      this.state.state
    );
  }

  async scan() {
    await this.ensureBridge();
    this.updateState({
      state: 'scanning',
      message: 'Scanning for Muse headbands…',
      devices: [],
      error: null,
    });
    this.send({ command: 'scan' });
    return this.getStatus();
  }

  async connect(address, name) {
    await this.ensureBridge();
    const device = { address, name: name || 'Muse' };
    this.store.set('muse:lastDevice', device);
    this.updateState({
      state: 'connecting',
      message: `Connecting to ${device.name}…`,
      device,
      error: null,
    });
    this.send({ command: 'connect', address, name: device.name });
    return this.getStatus();
  }

  async connectLast() {
    const last = this.store.get('muse:lastDevice');
    if (!last?.address) {
      throw new Error('No previously paired Muse device');
    }
    return this.connect(last.address, last.name);
  }

  async disconnect() {
    if (this.process) {
      this.send({ command: 'disconnect' });
    }
    this.updateState({
      state: 'idle',
      message: 'Disconnected',
      device: null,
      lastEeg: null,
      error: null,
    });
    return this.getStatus();
  }

  shutdown() {
    if (this.process) {
      try {
        this.send({ command: 'stop' });
      } catch {
        this.process.kill();
      }
      this.process = null;
    }
  }
}

module.exports = { MuseManager };

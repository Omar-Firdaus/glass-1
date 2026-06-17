const { app, BrowserWindow, ipcMain, shell, nativeImage, systemPreferences, session } = require('electron');
const path = require('path');
const http = require('http');
const { URL } = require('url');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Store = require('electron-store');
const { MuseManager } = require('./muse');
const store = new Store();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const OAUTH_REDIRECT_URI =
  process.env.OAUTH_REDIRECT_URI || 'http://127.0.0.1:42813/callback';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

let mainWindow = null;
let authWindow = null;
let museManager = null;

const iconPath = path.join(__dirname, '../assets/icon.png');
const appIcon = nativeImage.createFromPath(iconPath);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    titleBarStyle: 'hiddenInset',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const user = store.get('user');
  if (user) {
    mainWindow.loadFile(path.join(__dirname, '../src/dashboard.html'));
  } else {
    mainWindow.loadFile(path.join(__dirname, '../src/login.html'));
  }
}

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

function startCallbackServer() {
  return new Promise((resolve, reject) => {
    const redirectUrl = new URL(OAUTH_REDIRECT_URI);
    const port = parseInt(redirectUrl.port, 10) || 42813;

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, OAUTH_REDIRECT_URI);

      if (reqUrl.pathname !== redirectUrl.pathname) {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (error) {
        res.end(
          '<html><body style="background:#000;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>Sign-in failed. You can close this window.</p></body></html>'
        );
        server.close();
        reject(new Error(error));
        return;
      }

      res.end(
        '<html><body style="background:#000;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>Sign-in successful. You can close this window.</p></body></html>'
      );
      server.close();
      resolve(code);
    });

    server.listen(port, '127.0.0.1', () => {});
    server.on('error', reject);

    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timed out'));
    }, 120000);
  });
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: OAUTH_REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  return res.json();
}

async function fetchUserProfile(accessToken) {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to fetch user profile');
  }

  const data = await res.json();
  return {
    name: data.name,
    email: data.email,
    picture: data.picture,
    id: data.id,
  };
}

function openAuthWindow(authUrl) {
  authWindow = new BrowserWindow({
    width: 500,
    height: 700,
    parent: mainWindow,
    modal: true,
    backgroundColor: '#000000',
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  authWindow.loadURL(authUrl);

  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('auth:get-user', () => {
  return store.get('user') || null;
});

ipcMain.handle('auth:login', async () => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return {
      success: false,
      error:
        'Missing Google OAuth credentials. Copy .env.example to .env and add your client ID and secret.',
    };
  }

  try {
    const codePromise = startCallbackServer();
    const authUrl = buildAuthUrl();
    openAuthWindow(authUrl);

    const code = await codePromise;

    if (authWindow && !authWindow.isDestroyed()) {
      authWindow.close();
    }

    const tokens = await exchangeCodeForTokens(code);
    const user = await fetchUserProfile(tokens.access_token);

    store.set('user', user);
    store.set('tokens', {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });

    return { success: true, user };
  } catch (err) {
    if (authWindow && !authWindow.isDestroyed()) {
      authWindow.close();
    }
    return { success: false, error: err.message };
  }
});

ipcMain.handle('auth:logout', () => {
  store.delete('user');
  store.delete('tokens');
  if (mainWindow) {
    mainWindow.loadFile(path.join(__dirname, '../src/login.html'));
  }
  return { success: true };
});

ipcMain.handle('nav:go-dashboard', () => {
  if (mainWindow) {
    mainWindow.loadFile(path.join(__dirname, '../src/dashboard.html'));
  }
});

ipcMain.handle('muse:get-status', () => {
  return museManager ? museManager.getStatus() : null;
});

ipcMain.handle('muse:connect-auto', async () => {
  if (!museManager) return { success: false, error: 'Muse manager not ready' };
  try {
    const status = await museManager.connectAuto();
    return { success: true, status };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('muse:scan', async () => {
  if (!museManager) return { success: false, error: 'Muse manager not ready' };
  try {
    const status = await museManager.scan();
    return { success: true, status };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('muse:connect', async (_event, { address, name }) => {
  if (!museManager) return { success: false, error: 'Muse manager not ready' };
  try {
    const status = await museManager.connect(address, name);
    return { success: true, status };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('muse:connect-last', async () => {
  if (!museManager) return { success: false, error: 'Muse manager not ready' };
  try {
    const status = await museManager.connectLast();
    return { success: true, status };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('muse:disconnect', async () => {
  if (!museManager) return { success: false, error: 'Muse manager not ready' };
  try {
    const status = await museManager.disconnect();
    return { success: true, status };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'mediaKeySystem');
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'mediaKeySystem';
  });

  if (process.platform === 'darwin') {
    const cameraStatus = systemPreferences.getMediaAccessStatus('camera');
    if (cameraStatus !== 'granted') {
      await systemPreferences.askForMediaAccess('camera');
    }
  }

  if (process.platform === 'darwin' && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }
  museManager = new MuseManager(store, () => mainWindow);
  createWindow();
});

app.on('window-all-closed', () => {
  if (museManager) museManager.shutdown();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (museManager) museManager.shutdown();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

const { app, BrowserWindow, ipcMain, shell, nativeImage, session } = require('electron');
const path = require('path');
const http = require('http');
const { URL } = require('url');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { startMuseBridge, stopMuseBridge, registerMuseIpc } = require('./muse-bridge');
const { registerVisionIpc } = require('./vision');
const { registerTtsIpc } = require('./tts');

// Running via `electron path/to/main.js` defaults userData to ~/Library/Application Support/Electron.
app.setName('glass-1');

const Store = require('electron-store');
const store = new Store();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const OAUTH_REDIRECT_URI =
  process.env.OAUTH_REDIRECT_URI || 'http://127.0.0.1:42813/callback';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

let mainWindow = null;

const iconPath = path.join(__dirname, '../assets/icon.png');
const appIcon = nativeImage.createFromPath(iconPath);
const appPage = path.join(__dirname, '../src/app.html');
const loginPage = path.join(__dirname, '../src/login.html');

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
  mainWindow.loadFile(user ? appPage : loginPage);
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

async function openAuthInSystemBrowser(authUrl) {
  // Google blocks OAuth in embedded Electron windows (403 disallowed_useragent).
  // RFC 8252 requires using the system browser for native app OAuth.
  await shell.openExternal(authUrl);
}

const DEFAULT_SETTINGS = {
  glassesName: 'glass-1',
  museAutoConnect: false,
  museSampleRate: 256,
  cameraAutoStart: false,
  cameraResolution: '1280x720',
};

ipcMain.handle('settings:get', () => {
  return { ...DEFAULT_SETTINGS, ...(store.get('settings') || {}) };
});

ipcMain.handle('settings:set', (_event, partial) => {
  const next = { ...DEFAULT_SETTINGS, ...(store.get('settings') || {}), ...partial };
  store.set('settings', next);
  return next;
});

registerMuseIpc(ipcMain, store);
registerVisionIpc(ipcMain);
registerTtsIpc(ipcMain);

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
    await openAuthInSystemBrowser(authUrl);

    const code = await codePromise;

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
    return { success: false, error: err.message };
  }
});

ipcMain.handle('auth:logout', () => {
  store.delete('user');
  store.delete('tokens');
  if (mainWindow) {
    mainWindow.loadFile(loginPage);
  }
  return { success: true };
});

ipcMain.handle('nav:go-app', () => {
  if (mainWindow) {
    mainWindow.loadFile(appPage);
  }
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'camera');
  });

  if (process.platform === 'darwin' && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }
  startMuseBridge();
  createWindow();
});

app.on('before-quit', () => {
  stopMuseBridge();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

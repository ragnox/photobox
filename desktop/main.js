// Photobox desktop shell: starts the library server in a utility process and
// shows the web UI in a native window.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, shell, utilityProcess } from 'electron';
import { defaultDataDir } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
// Same library as the CLI, so `photobox serve` and the app share one database.
// The server process inherits PHOTOBOX_DATA from our environment, if set.
const dataDir = defaultDataDir();
const windowStatePath = path.join(dataDir, 'window.json');
const devIcon = path.join(here, '..', 'build', 'icon.png');

// Apps started from Finder get a bare PATH; ffmpeg usually lives in Homebrew.
if (isMac) {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'];
  process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(':'), ...extra])].filter(Boolean).join(':');
}

if (!app.requestSingleInstanceLock()) app.quit();

let server = null;
let serverUrl = null;
let win = null;
let quitting = false;

// --- library server ------------------------------------------------------------

function startServer() {
  return new Promise((resolve, reject) => {
    server = utilityProcess.fork(path.join(here, 'server-process.js'), [], {
      serviceName: 'Photobox Library',
      stdio: 'inherit',
    });
    server.on('message', (message) => {
      if (message.type === 'ready') resolve(message.url);
      if (message.type === 'already-running') {
        // A `photobox serve` owns this library - show that one instead.
        stopServer();
        resolve(message.url);
      }
      if (message.type === 'error') {
        stopServer();
        reject(new Error(message.message));
      }
    });
    server.on('exit', (code) => {
      const unexpected = server && !quitting;
      server = null;
      if (!unexpected) return;
      if (!serverUrl) reject(new Error(`Library process exited (code ${code})`));
      else {
        dialog.showErrorBox('Photobox stopped', `The library process exited unexpectedly (code ${code}).`);
        app.quit();
      }
    });
  });
}

function stopServer() {
  const child = server;
  server = null;
  child?.kill();
}

// --- window ----------------------------------------------------------------------

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    const { x, y, width, height } = state.bounds;
    // Only restore positions that are still on a connected display.
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      x >= a.x - 50 && y >= a.y - 50 && x + 100 <= a.x + a.width && y + 100 <= a.y + a.height);
    return { bounds: visible ? { x, y, width, height } : { width, height }, maximized: state.maximized };
  } catch {
    return { bounds: { width: 1320, height: 880 }, maximized: false };
  }
}

function saveWindowState() {
  if (!win) return;
  const state = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
  try {
    fs.writeFileSync(windowStatePath, JSON.stringify(state));
  } catch {
    // not worth bothering anyone about
  }
}

function openExternal(target) {
  if (/^https?:\/\//.test(target)) shell.openExternal(target);
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    ...state.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Photobox',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121211' : '#f7f7f5',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 22 },
    // A packaged app has its icon built in; build/icon.png only exists in a checkout.
    icon: isMac || app.isPackaged ? undefined : devIcon,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // The window only ever shows the local library; links go to the real browser.
  const origin = new URL(serverUrl).origin;
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === origin) return;
    event.preventDefault();
    openExternal(url);
  });

  win.on('close', saveWindowState);
  win.on('closed', () => (win = null));
  win.loadURL(serverUrl);
  return win;
}

function showWindow() {
  if (!serverUrl) return null;
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
  return win;
}

/** Send a menu action to the UI, opening the window first if needed. */
function sendToUI(action) {
  const target = showWindow();
  if (!target) return;
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', () => target.webContents.send('menu', action));
  else target.webContents.send('menu', action);
}

// --- native features for the UI ----------------------------------------------------

ipcMain.handle('pick-folder', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Add photos to Photobox',
    message: 'Choose a folder of photos or an extracted Google Takeout',
    buttonLabel: 'Add Folder',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.on('reveal', (_event, file) => {
  if (typeof file === 'string' && path.isAbsolute(file)) shell.showItemInFolder(file);
});

ipcMain.on('progress', (event, fraction) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (typeof fraction === 'number') target?.setProgressBar(fraction);
});

// --- menu ---------------------------------------------------------------------------

function buildMenu() {
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add Folder…', accelerator: 'CmdOrCtrl+O', click: () => sendToUI('add-folder') },
        { label: 'Rescan All Folders', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendToUI('rescan') },
        { type: 'separator' },
        { label: 'Open in Browser', click: () => serverUrl && shell.openExternal(serverUrl) },
        { label: 'Show Library Data', click: () => shell.openPath(dataDir) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

// --- lifecycle ------------------------------------------------------------------------

app.setName('Photobox');

app.on('second-instance', () => showWindow());

app.on('window-all-closed', () => {
  // On macOS the app (and folder watching) keeps running until you quit it.
  if (!isMac) app.quit();
});

app.on('before-quit', (event) => {
  quitting = true;
  if (!server) return;
  // Let the server close the database and remove its lock before we go.
  event.preventDefault();
  const child = server;
  child.once('exit', () => app.quit());
  child.postMessage({ type: 'shutdown' });
  setTimeout(() => child.kill(), 3000);
});

app.whenReady().then(async () => {
  if (isMac && !app.isPackaged && fs.existsSync(devIcon)) app.dock?.setIcon(devIcon);
  Menu.setApplicationMenu(buildMenu());
  try {
    serverUrl = await startServer();
  } catch (err) {
    dialog.showErrorBox('Photobox could not start', err.message);
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => showWindow());
});

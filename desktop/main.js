// Menu-bar host: renderer windows can come and go without interrupting backup.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, Tray, nativeImage, dialog, ipcMain, nativeTheme, screen, shell, utilityProcess, powerMonitor } from 'electron';
import { defaultDataDir } from '../src/config.js';
import { loadHostSettings, saveHostSettings } from '../src/host-settings.js';
import { prepareDesktopHost, loadDesktopPreferences, saveDesktopPreferences } from './preferences.js';
import { syncStatus, formatBytes } from './status.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const dataDir = defaultDataDir();
const smokeFile = process.env.PHOTOBOX_DESKTOP_SMOKE_FILE;
if (smokeFile && (!process.env.PHOTOBOX_DATA || dataDir === path.join(os.homedir(), '.photobox'))) throw new Error('Desktop smoke tests require an isolated PHOTOBOX_DATA');
fs.mkdirSync(path.join(dataDir, 'desktop-runtime'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(dataDir, 'desktop-runtime'));
const logPath = path.join(dataDir, 'logs', 'desktop.log');
const windowStatePath = path.join(dataDir, 'window.json');
const devIcon = path.join(here, '..', 'build', 'icon.png');

function log(message) {
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 ** 2) {
      fs.rmSync(`${logPath}.2`, { force: true });
      if (fs.existsSync(`${logPath}.1`)) fs.renameSync(`${logPath}.1`, `${logPath}.2`);
      fs.renameSync(logPath, `${logPath}.1`);
    }
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${String(message).trim()}\n`, { mode: 0o600 });
  } catch { /* The tray still needs to work if a log volume is full. */ }
}

if (isMac) process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin'])].filter(Boolean).join(':');
app.setName('Photobox');
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

let child = null, serverUrl = null, win = null, tray = null;
let quitting = false, shutdownComplete = false, booting = null, changing = false;
let lastStatus = null, hostInfo = null, serviceError = null, failedPolls = 0;
let retryTimer = null, pollTimer = null, polling = false, retryDelay = 1000;
let menuOpen = false, menuKey = null;
let windowWasOpened = false;
const images = new Map();

function image(name) {
  if (!images.has(name)) {
    const icon = nativeImage.createFromPath(path.join(here, 'icons', `${name}Template.png`));
    if (icon.isEmpty()) throw new Error(`Missing menu-bar artwork: ${name}`);
    icon.setTemplateImage(isMac);
    images.set(name, icon);
  }
  return images.get(name);
}

function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Host is not a local Photobox server');
  return url.origin;
}

async function api(route, body, url = serverUrl) {
  if (!url) throw new Error('Photobox host is starting');
  const response = await fetch(`${localUrl(url)}${route}`, {
    ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(value.error ?? `Host request failed (${response.status})`);
  }
  return response.json();
}

function scheduleRestart(reason) {
  if (quitting || retryTimer) return;
  serviceError = reason;
  log(reason);
  renderTray();
  retryTimer = setTimeout(() => { retryTimer = null; boot().catch(() => {}); }, retryDelay);
  retryDelay = Math.min(30_000, retryDelay * 2);
}

function startChild() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settings = loadHostSettings(dataDir);
    const process = utilityProcess.fork(path.join(here, 'server-process.js'), [], {
      serviceName: 'Photobox Library', stdio: 'pipe',
      env: { ...globalThis.process.env, PHOTOBOX_PORT: String(settings.port), PHOTOBOX_BACKUP_DIR: settings.backupDir ?? '' },
    });
    child = process;
    process.stdout?.on('data', (data) => log(data));
    process.stderr?.on('data', (data) => log(data));
    process.on('message', (message) => {
      if (message.type === 'ready' || message.type === 'already-running') {
        settled = true;
        if (message.type === 'already-running') child = null;
        resolve(localUrl(message.url));
      } else if (message.type === 'error') {
        settled = true;
        if (child === process) child = null;
        process.kill();
        reject(new Error(message.message));
      }
    });
    process.on('exit', (code) => {
      if (!settled) { settled = true; if (child === process) child = null; reject(new Error(`Library process exited (${code})`)); return; }
      if (child !== process) return;
      child = null;
      if (!quitting) { serverUrl = null; scheduleRestart(`Library process stopped (${code}); restarting`); }
    });
  });
}

async function boot() {
  if (quitting) return;
  if (booting) return booting;
  booting = (async () => {
    try {
      serverUrl = await startChild();
      serviceError = null; failedPolls = 0; retryDelay = 1000;
      log(`Host ready at ${serverUrl} (${child ? 'desktop-managed' : 'attached to existing host'})`);
      if (win) win.loadURL(serverUrl);
      await poll();
    } catch (err) { serverUrl = null; scheduleRestart(err.message); }
  })().finally(() => { booting = null; });
  return booting;
}

async function stopChild() {
  const process = child;
  child = null;
  if (!process) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { log('Host shutdown timed out; terminating resumable work'); process.kill(); }, 30_000);
    process.once('exit', () => { clearTimeout(timer); resolve(); });
    process.postMessage({ type: 'shutdown' });
  });
}

/** A host started from a terminal on the library the app opens, which the app may stop and replace. */
const sameCliLibrary = (info) => info?.managedBy === 'cli' && (info.archive ?? null) === loadHostSettings(dataDir).archive && path.resolve(info.dataDir) === dataDir;

async function restartHost() {
  const oldUrl = serverUrl;
  const oldInfo = hostInfo;
  serverUrl = null; lastStatus = null; hostInfo = null;
  if (child) await stopChild();
  else if (sameCliLibrary(oldInfo)) {
    await api('/api/host/shutdown', {}, oldUrl);
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await api('/api/status', undefined, oldUrl); }
      catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } else throw new Error('Quit the older terminal host once, then choose Restart Host');
  await boot();
}

async function poll() {
  if (polling || quitting || !serverUrl) return;
  polling = true;
  try {
    lastStatus = await api('/api/status');
    hostInfo = await api('/api/host').catch(() => null);
    serviceError = null; failedPolls = 0;
    if (smokeFile) {
      const value = { tray: Boolean(tray && !tray.isDestroyed()), window: Boolean(win), owned: Boolean(child),
        windowWasOpened, url: serverUrl, host: hostInfo, status: lastStatus, version: app.getVersion(), packaged: app.isPackaged };
      fs.writeFileSync(`${smokeFile}.partial`, JSON.stringify(value));
      fs.renameSync(`${smokeFile}.partial`, smokeFile);
    }
  } catch (err) {
    serviceError = err.message;
    if (++failedPolls >= 3 && !child) { serverUrl = null; scheduleRestart('Existing host is unavailable; trying the built-in host'); }
    else if (failedPolls >= 3 && child && !changing && !booting) {
      log('Host health check failed repeatedly; restarting the library worker');
      changing = true;
      try { await restartHost(); } catch (restartError) { scheduleRestart(restartError.message); }
      finally { changing = false; }
    }
  } finally { polling = false; renderTray(); }
}

function windowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    const { x, y, width, height } = state.bounds;
    const visible = screen.getAllDisplays().some(({ workArea: a }) => x >= a.x - 50 && y >= a.y - 50 && x + 100 <= a.x + a.width && y + 100 <= a.y + a.height);
    return { bounds: visible ? { x, y, width, height } : { width, height }, maximized: state.maximized };
  } catch { return { bounds: { width: 1320, height: 880 }, maximized: false }; }
}

function openExternal(url) { if (/^https?:\/\//.test(url)) shell.openExternal(url); }

function showWindow() {
  if (!serverUrl) return null;
  app.dock?.show();
  if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); return win; }
  const state = windowState();
  windowWasOpened = true;
  win = new BrowserWindow({
    ...state.bounds, minWidth: 720, minHeight: 480, show: false, title: 'Photobox',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121211' : '#f7f7f5',
    titleBarStyle: isMac ? 'hiddenInset' : 'default', trafficLightPosition: { x: 20, y: 22 },
    icon: !isMac && !app.isPackaged ? devIcon : undefined,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(serverUrl).origin) { event.preventDefault(); openExternal(url); }
  });
  // Only right-clicks the page didn't handle itself arrive here.
  win.webContents.on('context-menu', (_event, params) => {
    const items = editMenu(params);
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.on('close', () => {
    try { fs.writeFileSync(windowStatePath, JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* optional window state */ }
  });
  win.on('closed', () => { win = null; if (!quitting) app.dock?.hide(); });
  win.loadURL(serverUrl);
  return win;
}

function sendToUI(action) {
  const target = showWindow();
  if (!target) return;
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', () => target.webContents.send('menu', action));
  else target.webContents.send('menu', action);
}

function trusted(event) {
  try { return event.sender === win?.webContents && new URL(event.senderFrame.url).origin === new URL(serverUrl).origin; }
  catch { return false; }
}
ipcMain.handle('pick-folder', async (event) => {
  if (!trusted(event)) throw new Error('Untrusted window');
  const result = await dialog.showOpenDialog(win, { title: 'Add photos to Photobox', buttonLabel: 'Add Folder', properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.on('reveal', (event, file) => { if (trusted(event) && typeof file === 'string' && path.isAbsolute(file)) shell.showItemInFolder(file); });
// A photo's right-click menu, as the page lists it: resolves with the chosen item's id, or null.
ipcMain.handle('context-menu', (event, items) => {
  if (!trusted(event) || !Array.isArray(items)) return null;
  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate(items.slice(0, 20).filter((i) => typeof i?.id === 'string' && typeof i.label === 'string').map((i) => ({
      label: i.label, accelerator: typeof i.keys === 'string' ? i.keys : undefined, registerAccelerator: false, click: () => resolve(i.id),
    })));
    // macOS can report the menu closed before the click on an item arrives: that click still wins.
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(null), 100) });
  });
});

/** The usual edit menu for text fields and selected text; photos have their own (see above). */
function editMenu({ isEditable, selectionText, editFlags }) {
  if (isEditable) {
    return [{ role: 'cut', enabled: editFlags.canCut }, { role: 'copy', enabled: editFlags.canCopy }, { role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' }, { role: 'selectAll', enabled: editFlags.canSelectAll }];
  }
  return selectionText.trim() ? [{ role: 'copy' }] : [];
}
ipcMain.on('progress', (event, fraction) => { if (!lastStatus && trusted(event) && typeof fraction === 'number') win?.setProgressBar(fraction); });

const installed = () => isMac && app.isPackaged && app.isInApplicationsFolder() && !smokeFile;
function configureLogin(openAtLogin) {
  if (!installed()) return;
  app.setLoginItemSettings({ openAtLogin, args: ['--background'] });
  saveDesktopPreferences(dataDir, { loginConfigured: true });
}

async function change(action) {
  if (changing) return;
  changing = true; renderTray();
  try { await action(); await poll(); }
  catch (err) { log(err.stack ?? err.message); dialog.showErrorBox('Photobox', err.message); }
  finally { changing = false; renderTray(); }
}

async function chooseExport() {
  const options = { title: 'Export phone originals to…', message: 'Choose a folder outside Photobox data. Originals are kept in the inbox too.', properties: ['openDirectory', 'createDirectory'] };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (!result.canceled) await api('/api/host/backup-directory', { path: result.filePaths[0] });
}

function renderTray() {
  if (!tray || tray.isDestroyed()) return;
  const state = syncStatus(serviceError ? null : lastStatus, serviceError);
  const percent = state.progress === null ? null : Math.round(state.progress * 100);
  const name = ['error', 'warning'].includes(state.level) ? 'warning' : state.busy ? percent === null ? 'busy' : `progress-${Math.round(percent / 10) * 10}` : 'tray';
  tray.setImage(image(name));
  tray.setToolTip(`Photobox — ${state.title}${percent !== null ? ` (${percent}%)` : ''}`);
  if (isMac) tray.setTitle(state.busy && percent !== null ? `${percent}%` : '');
  win?.setProgressBar(state.busy ? state.progress ?? 2 : -1);
  const available = Boolean(serverUrl && !serviceError);
  const manageable = Boolean(child || sameCliLibrary(hostInfo));
  const menu = [
    { label: state.title.slice(0, 140), enabled: false },
    ...(state.detail ? [{ label: state.detail.slice(0, 180), enabled: false }] : []),
    ...(state.counts ? [{ label: state.counts, enabled: false }] : []),
    ...(!child && serverUrl ? [{ label: 'Connected to an existing host', enabled: false }] : []),
    ...(lastStatus?.uploads?.transfers ?? []).filter((t) => t.active).slice(0, 4).map((t) => ({ label: `${t.filename}: ${formatBytes(t.bytesDone)} / ${formatBytes(t.totalBytes)}`, enabled: false })),
    { type: 'separator' },
    { label: 'Open Library', enabled: available, click: showWindow },
    { label: 'Connect a Phone…', enabled: available && Boolean(lastStatus?.network), click: () => sendToUI('connect-phone') },
    { label: 'Open in Browser', enabled: available, click: () => shell.openExternal(serverUrl) },
    { type: 'separator' },
    { label: 'Choose Export Folder…', enabled: available && Boolean(hostInfo) && !changing, click: () => change(chooseExport) },
    { label: 'Show Export Folder', enabled: Boolean(lastStatus?.backup?.destination), click: () => shell.openPath(lastStatus.backup.destination) },
    { label: 'Retry Backup / Refresh Metadata', enabled: available && !changing, click: () => change(() => api('/api/host/retry', {})) },
    { label: 'Phone Access over HTTPS', type: 'checkbox', checked: Boolean(lastStatus?.network), enabled: manageable && !changing,
      click: (item) => change(async () => { saveHostSettings(dataDir, { listen: item.checked ? '0.0.0.0' : null }); await restartHost(); }) },
    ...(isMac ? [{ label: 'Launch at Login', type: 'checkbox', checked: installed() && app.getLoginItemSettings().openAtLogin,
      enabled: installed(), click: (item) => { configureLogin(item.checked); renderTray(); } }] : []),
    ...(installed() && app.getLoginItemSettings().status === 'requires-approval' ? [{ label: 'Approve in Login Items Settings…', click: () => shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension') }] : []),
    { label: 'Restart Host', enabled: !changing && !booting && (manageable || !serverUrl), click: () => change(async () => {
      clearTimeout(retryTimer); retryTimer = null;
      if (serverUrl) await restartHost(); else await boot();
    }) },
    { type: 'separator' },
    { label: 'Show Logs', click: () => shell.openPath(logPath) },
    { label: 'Show Library Data', click: () => shell.openPath(dataDir) },
    { label: 'Source Code & Help', click: () => shell.openExternal('https://github.com/ragnox/photobox') },
    { role: 'quit', label: 'Quit Photobox' },
  ];
  const key = JSON.stringify(menu);
  if (!menuOpen && key !== menuKey) {
    const context = Menu.buildFromTemplate(menu);
    context.on('menu-will-show', () => { menuOpen = true; });
    context.on('menu-will-close', () => { menuOpen = false; setImmediate(renderTray); });
    tray.setContextMenu(context);
    menuKey = key;
  }
}

function appMenu() {
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Add Folder…', accelerator: 'CmdOrCtrl+O', click: () => sendToUI('add-folder') },
      { label: 'Connect a Phone…', click: () => sendToUI('connect-phone') },
      { label: 'Rescan All Folders', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendToUI('rescan') },
      { type: 'separator' }, { role: 'close' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { role: 'windowMenu' },
  ]);
}

app.on('second-instance', (_event, argv) => { if (!argv.includes('--background')) showWindow(); });
app.on('window-all-closed', () => { /* The tray and host own the app lifetime. */ });
app.on('activate', showWindow);
process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  clearInterval(pollTimer); clearTimeout(retryTimer);
  stopChild().finally(() => { shutdownComplete = true; tray?.destroy(); app.quit(); });
});

if (primary) app.whenReady().then(async () => {
  log(`Photobox ${app.getVersion()} starting (${process.arch}, packaged=${app.isPackaged})`);
  tray = new Tray(image('busy'));
  tray.on('double-click', showWindow);
  Menu.setApplicationMenu(appMenu());
  app.setAboutPanelOptions({ applicationName: 'Photobox', applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 Photobox contributors · MIT', website: 'https://github.com/ragnox/photobox',
    credits: 'Built with Electron, Node.js, SQLite, sharp/libvips and open-source dependencies. See THIRD_PARTY_NOTICES.md in the source.' });
  renderTray();
  try { prepareDesktopHost(dataDir, { smoke: Boolean(smokeFile) }); }
  catch (err) { serviceError = err.message; log(err.message); renderTray(); return; }
  if (installed() && !loadDesktopPreferences(dataDir).loginConfigured) configureLogin(true);
  const background = process.argv.includes('--background') || (isMac && app.getLoginItemSettings().wasOpenedAtLogin);
  if (background) app.dock?.hide();
  else if (isMac && !app.isPackaged && fs.existsSync(devIcon)) app.dock?.setIcon(devIcon);
  await boot();
  if (!background && serverUrl) showWindow();
  if (smokeFile && process.argv.includes('--smoke-close-window') && serverUrl) {
    const target = showWindow();
    target.webContents.once('did-finish-load', () => setTimeout(() => target.close(), 500));
  }
  pollTimer = setInterval(() => poll().catch((err) => log(err.message)), 2000);
  powerMonitor.on('resume', () => { poll().catch(() => {}); if (serverUrl) api('/api/host/retry', {}).catch(() => {}); });
}).catch((err) => { log(err.stack ?? err.message); dialog.showErrorBox('Photobox could not start', err.message); app.quit(); });

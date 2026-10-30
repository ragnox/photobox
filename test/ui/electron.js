// The browser for the UI test: one hidden Electron window, driven over stdin/stdout by test/ui/page.js.
// It never shows a window or a Dock icon, never uses your Electron profile, and can't reach the clipboard.
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, ipcMain, session } from 'electron';

app.setPath('userData', process.env.PHOTOBOX_UI_PROFILE);
Menu.setApplicationMenu(null); // no Edit menu turning ⌘C into a real copy
app.dock?.hide();

const send = (message) => process.stdout.write(`@ui ${JSON.stringify(message)}\n`);

// PHOTOBOX_UI_DESKTOP=1: the page runs with the desktop app's preload. In place of desktop/main.js, native
// menus answer with the test's choice instead of popping up, and nothing is shown in Finder.
const asDesktop = process.env.PHOTOBOX_UI_DESKTOP === '1';
let menuChoice = null;
ipcMain.handle('context-menu', (event, items) => { send({ menu: items }); return menuChoice; });
ipcMain.on('reveal', (event, file) => send({ revealed: file }));

// Not a top-level await: Electron doesn't get ready until this module has finished loading.
app.whenReady().then(() => {
  const ses = session.fromPartition('photobox-ui-test'); // in memory, gone when the test ends
  ses.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const preload = asDesktop ? { preload: fileURLToPath(new URL('../../desktop/preload.cjs', import.meta.url)), contextIsolation: true, sandbox: true } : {};
  const win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { session: ses, backgroundThrottling: false, ...preload } });
  const page = win.webContents;
  page.on('console-message', (e, level, message) => send({ console: { level: e.level ?? level, message: e.message ?? message } }));
  page.on('render-process-gone', (e, details) => send({ console: { level: 'error', message: `page crashed: ${details.reason}` } }));

  const commands = {
    load: (url) => win.loadURL(url),
    eval: (code) => page.executeJavaScript(code, true),
    input: (events) => { for (const event of events) page.sendInputEvent(event); },
    insertText: (text) => page.insertText(text),
    screenshot: async (file) => fs.writeFileSync(file, (await page.capturePage()).toPNG()),
    menuChoice: (id) => { menuChoice = id; },
  };

  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    const { id, command, arg } = JSON.parse(line);
    try {
      send({ id, value: await commands[command](arg) });
    } catch (err) {
      send({ id, error: err.message });
    }
  }).on('close', () => app.quit());
  send({ ready: true });
});

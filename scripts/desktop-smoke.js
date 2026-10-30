// Real Electron integration, always isolated from the user's host/photos/login items.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const appIndex = process.argv.indexOf('--app');
const bundle = appIndex >= 0 ? path.resolve(process.argv[appIndex + 1]) : null;
const executable = bundle ? path.join(bundle, 'Contents', 'MacOS', 'Photobox') : require('electron');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-desktop-smoke-'));
const data = path.join(tmp, 'data');
const exportDir = path.join(tmp, 'photos');
const snapshot = path.join(tmp, 'status.json');
await fs.mkdir(exportDir);
const env = { ...process.env, PHOTOBOX_DATA: data, PHOTOBOX_BACKUP_DIR: exportDir, PHOTOBOX_PORT: '0', PHOTOBOX_DESKTOP_SMOKE_FILE: snapshot };
delete env.ELECTRON_RUN_AS_NODE;
let output = '';
const child = spawn(executable, [...(bundle ? [] : [root]), '--background', '--smoke-close-window'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-64_000); });
child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-64_000); });
const finished = new Promise((resolve) => child.once('exit', resolve));

async function waitFor(check) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Desktop exited early (${child.exitCode})\n${output}`);
    try { const value = JSON.parse(await fs.readFile(snapshot, 'utf8')); if (check(value)) return value; } catch (err) { if (!['ENOENT'].includes(err.code) && !(err instanceof SyntaxError)) throw err; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const log = await fs.readFile(path.join(data, 'logs', 'desktop.log'), 'utf8').catch(() => '');
  throw new Error(`Desktop smoke timed out\n${output}\n${log}`);
}

try {
  const initial = await waitFor((s) => s.tray && s.owned && s.windowWasOpened && !s.window && s.status?.network);
  assert.equal(initial.host.managedBy, 'desktop');
  assert.equal(initial.status.backup.destination, exportDir);
  console.log('PASS: Electron tray, native window close, bundled library and paired HTTPS listener');
  const firstPid = initial.host.pid;
  process.kill(firstPid, 'SIGKILL');
  const recovered = await waitFor((s) => s.owned && s.host?.pid !== firstPid && s.status?.backup?.configured);
  console.log('PASS: library worker crash automatically recovered');
  const newExport = path.join(tmp, 'new-photos');
  await fs.mkdir(newExport);
  const changed = await fetch(`${recovered.url}/api/host/backup-directory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: newExport }) });
  assert.equal(changed.status, 200);
  await waitFor((s) => s.status?.backup?.destination === newExport);
  process.kill(recovered.host.pid, 'SIGKILL');
  const again = await waitFor((s) => s.host?.pid !== recovered.host.pid && s.status?.backup?.destination === newExport);
  assert.ok(again.tray && !again.window);
  console.log('PASS: export/network preferences survive worker restart without a window');
} finally {
  child.kill('SIGTERM');
  await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 35_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await fs.rm(tmp, { recursive: true, force: true });
}

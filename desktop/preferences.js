import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadHostSettings, saveHostSettings, hostSettingsPath } from '../src/host-settings.js';

export function prepareDesktopHost(dataDir, { smoke = false, home = os.homedir() } = {}) {
  if (!fs.existsSync(hostSettingsPath(dataDir))) {
    const separateData = process.env.PHOTOBOX_DATA || smoke;
    const defaultExport = separateData ? path.join(path.dirname(dataDir), `${path.basename(dataDir)}-photos`) : path.join(home, 'Photos');
    const backupDir = process.env.PHOTOBOX_BACKUP_DIR ?? defaultExport;
    if (backupDir === defaultExport) fs.mkdirSync(defaultExport, { recursive: true });
    saveHostSettings(dataDir, { port: Number(process.env.PHOTOBOX_PORT ?? (smoke ? 0 : 4567)), listen: smoke ? '127.0.0.1' : '0.0.0.0',
      remotePort: smoke ? 0 : 4568, backupDir: backupDir ? path.resolve(backupDir) : null });
  }
  // Shell overrides configure this launch; subsequent worker restarts use the
  // current saved preferences, including changes made in the menu bar.
  const overrides = {};
  if (process.env.PHOTOBOX_PORT !== undefined) overrides.port = Number(process.env.PHOTOBOX_PORT);
  if (process.env.PHOTOBOX_BACKUP_DIR !== undefined) overrides.backupDir = process.env.PHOTOBOX_BACKUP_DIR ? path.resolve(process.env.PHOTOBOX_BACKUP_DIR) : null;
  if (Object.keys(overrides).length) saveHostSettings(dataDir, overrides);
  return loadHostSettings(dataDir);
}

export function loadDesktopPreferences(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop.json'), 'utf8'));
    return { loginConfigured: value.loginConfigured === true };
  } catch { return { loginConfigured: false }; }
}

export function saveDesktopPreferences(dataDir, value) {
  const target = path.join(dataDir, 'desktop.json');
  fs.writeFileSync(`${target}.partial`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${target}.partial`, target);
}

// Non-secret host preferences shared by the desktop service and CLI.
// Device tokens/private keys stay in their existing dedicated stores.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULTS = { version: 1, port: 4567, listen: null, remotePort: null, backupDir: null, tlsCert: null, tlsKey: null, archive: null };
export const hostSettingsPath = (dataDir) => path.join(dataDir, 'host.json');

export function loadHostSettings(dataDir) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(hostSettingsPath(dataDir), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return { ...DEFAULTS }; throw new Error('Cannot read Photobox host settings'); }
  return validate(saved);
}

function validate(saved) {
  if (!saved || typeof saved !== 'object' || saved.version !== 1) throw new Error('Unsupported Photobox host settings version');
  const settings = { ...DEFAULTS, ...saved };
  for (const key of ['port', 'remotePort']) {
    if ((key === 'port' || settings[key] !== null) && (!Number.isInteger(settings[key]) || settings[key] < 0 || settings[key] > 65535)) {
      throw new Error(`Invalid host setting: ${key}`);
    }
  }
  if (settings.listen !== null && (typeof settings.listen !== 'string' || !settings.listen.trim() || /[\s/]/.test(settings.listen))) throw new Error('Invalid host listen address');
  if (settings.backupDir !== null && (typeof settings.backupDir !== 'string' || !path.isAbsolute(settings.backupDir))) throw new Error('Invalid host export directory');
  if (settings.archive !== null && (typeof settings.archive !== 'string' || !path.isAbsolute(settings.archive))) throw new Error('Invalid host archive');
  for (const key of ['tlsCert', 'tlsKey']) if (settings[key] !== null && (typeof settings[key] !== 'string' || !path.isAbsolute(settings[key]))) throw new Error('Invalid host TLS file path');
  if (Boolean(settings.tlsCert) !== Boolean(settings.tlsKey)) throw new Error('Host TLS certificate and key must be configured together');
  return Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, settings[key]]));
}

export function saveHostSettings(dataDir, changes) {
  const values = { ...loadHostSettings(dataDir), ...changes, version: 1 };
  const settings = validate(values);
  fs.mkdirSync(dataDir, { recursive: true });
  const target = hostSettingsPath(dataDir);
  const partial = path.join(dataDir, `.host-${randomUUID()}.partial`);
  try {
    const fd = fs.openSync(partial, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(partial, target);
    const directory = fs.openSync(dataDir, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { fs.rmSync(partial, { force: true }); }
  return settings;
}

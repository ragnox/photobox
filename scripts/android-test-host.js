// Synthetic, loopback-only fixture for the Kotlin/Node interoperability test.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startPhotobox } from '../src/app.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-kotlin-host-'));
const backupDir = path.join(tmp, 'photos');
await fs.mkdir(backupDir);
const app = await startPhotobox({ dataDir: path.join(tmp, 'data'), backupDir, port: 0, remotePort: 0, listen: '127.0.0.1' });
const response = await fetch(`${app.url}/api/pairing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const pairing = await response.json();
process.stdout.write(`${pairing.links[0].native.payload}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);

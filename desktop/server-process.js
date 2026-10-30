// The background host runs independently of the library window/renderer.
import { startPhotobox, AlreadyRunning } from '../src/app.js';
import { defaultDataDir } from '../src/config.js';
import { loadHostSettings } from '../src/host-settings.js';
import { readArchive } from '../src/archive.js';

const send = (message) => process.parentPort.postMessage(message);
let photobox;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await photobox?.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.parentPort.on('message', ({ data }) => { if (data?.type === 'shutdown') shutdown().catch(console.error); });

/** The archive the host last served, or null: the library in the data folder. */
function savedArchive() {
  const { archive } = loadHostSettings(defaultDataDir());
  if (!archive) return null;
  const found = readArchive(archive);
  if (!found) throw new Error(`The archive ${archive} isn't there (an unplugged drive?) - plug it in, or run photobox serve once where Photobox should open`);
  return found;
}

try {
  photobox = await startPhotobox({ managedBy: 'desktop', archive: savedArchive() });
  photobox.hostControl.shutdown = shutdown;
  send({ type: 'ready', url: photobox.url });
} catch (err) {
  if (err instanceof AlreadyRunning) send({ type: 'already-running', url: err.url });
  else send({ type: 'error', message: err.message });
  setTimeout(() => process.exit(err instanceof AlreadyRunning ? 0 : 1), 100);
}

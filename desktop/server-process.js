// Runs the library server in an Electron utility process, so scanning and
// thumbnailing never block the window. Talks to main.js over parentPort.
import { startPhotobox, AlreadyRunning } from '../src/app.js';

const send = (message) => process.parentPort.postMessage(message);

try {
  // Port 0: let the OS pick, so the desktop app never collides with a CLI server.
  const photobox = await startPhotobox({ port: 0 });
  send({ type: 'ready', url: photobox.url });

  process.parentPort.on('message', async ({ data }) => {
    if (data?.type !== 'shutdown') return;
    await photobox.close();
    process.exit(0);
  });
} catch (err) {
  if (err instanceof AlreadyRunning) send({ type: 'already-running', url: err.url });
  else send({ type: 'error', message: err.message });
}

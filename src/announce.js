// Telling phones on the local network where Photobox is (DNS-SD `_photobox._tcp`), so a paired
// phone finds this computer again after the Wi-Fi router gave it another address. The system's
// own mDNS responder announces it: Bonjour on macOS, Avahi on Linux. Without one, phones keep
// using the address they paired with. Which host is the paired one only TLS tells them, so
// the announcement carries nothing but the port.
import { spawn } from 'node:child_process';

export const SERVICE = '_photobox._tcp';

/** The command that announces `port` on `platform`, or null where there's no responder to ask. */
export function announceCommand(port, platform = process.platform) {
  if (platform === 'darwin') return ['/usr/bin/dns-sd', ['-R', 'Photobox', SERVICE, 'local', String(port)]];
  if (platform === 'linux') return ['avahi-publish-service', ['Photobox', SERVICE, String(port)]];
  return null;
}

/**
 * Announce `port` until close() or until this process ends: a shell runs the announcer and
 * stops it when our end of its input closes, so a host that crashed doesn't stay announced.
 */
export function announce(port, { platform = process.platform, run = spawn } = {}) {
  const command = announceCommand(port, platform);
  if (!command) return { close() {} };
  const child = run('/bin/sh', ['-c', '"$@" & p=$!; read _; kill $p', 'sh', command[0], ...command[1]],
    { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {}); // Nothing to announce with: phones use the address they paired with.
  child.stdin.on('error', () => {});
  child.unref();
  child.stdin.unref?.();
  return { close() { child.stdin.end(); } };
}

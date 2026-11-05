// What Photobox is doing and what it did, for the app's status bar and its activity log: imports,
// phones backing up, exports, copies to a backup drive, deletions. Photobox reports its own work
// here; other programs on this computer (an export, a backup script) report through
// `photobox activity`, which tells the running Photobox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP = 300; // log entries kept
const SHOWN = 60; // ... and the newest ones the app gets
const PHONE_IDLE_MS = 60_000; // a phone that asked nothing for this long is done backing up
export const STALE_MS = 15 * 60_000; // another program that stopped saying how it's going

/** `~/Pictures` for the Pictures folder in your home folder. */
export function tilde(file) {
  const home = os.homedir();
  return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

export const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function load(file) {
  try {
    const log = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(log) ? log.filter((e) => Number.isFinite(e?.at) && typeof e.text === 'string').slice(0, KEEP) : [];
  } catch { return []; }
}

export class Activity {
  /** `file` keeps the log across restarts; null keeps it in memory only. */
  constructor(file = null, { now = Date.now, phoneIdleMs = PHONE_IDLE_MS } = {}) {
    this.file = file;
    this.now = now;
    this.phoneIdleMs = phoneIdleMs;
    this.log = file ? load(file) : [];
    this.running = new Map(); // id -> { id, text, done, total, since, updatedAt, staleMs }
    this.phones = new Map(); // device id -> { name, received, timer }
    this.saveTimer = null;
  }

  /** Something is going on, or has got further. */
  start(id, text, { done = null, total = null, staleMs = null } = {}) {
    const was = this.running.get(id);
    this.running.set(id, { id, text, done, total, since: was?.since ?? this.now(), updatedAt: this.now(), staleMs });
  }

  /** It's over. `text` goes into the log; without one there was nothing worth saying. */
  end(id, text = null, { failed = false } = {}) {
    this.running.delete(id);
    if (text) this.add(text, { failed });
  }

  /** Something that happened. The same thing again (a phone finding nothing new) is counted, not repeated. */
  add(text, { failed = false } = {}) {
    const last = this.log[0];
    if (last && last.text === text && Boolean(last.failed) === failed) {
      last.times = (last.times ?? 1) + 1;
      last.since ??= last.at;
      last.at = this.now();
    } else {
      this.log.unshift({ at: this.now(), text, ...(failed ? { failed: true } : {}) });
      this.log.length = Math.min(this.log.length, KEEP);
    }
    this.#save();
  }

  /** A phone asked something while backing up; `received` is a photo it sent that arrived whole. */
  phone(device, received = false) {
    const session = this.phones.get(device.id) ?? { name: device.name, received: 0, timer: null };
    if (received) session.received++;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.#phoneDone(device.id), this.phoneIdleMs);
    session.timer.unref?.();
    this.phones.set(device.id, session);
    this.start(`phone:${device.id}`, session.received
      ? `Receiving photos from ${session.name} · ${session.received.toLocaleString('en-US')} so far`
      : `${session.name} is backing up`);
  }

  #phoneDone(deviceId) {
    const session = this.phones.get(deviceId);
    if (!session) return;
    this.phones.delete(deviceId);
    this.end(`phone:${deviceId}`, session.received
      ? `Received ${count(session.received, 'photo')} from ${session.name}`
      : `${session.name} backed up: nothing new`);
  }

  /** What's going on now (`live`: what the caller is doing itself) and the newest log entries. */
  snapshot(live = []) {
    for (const item of [...this.running.values()]) {
      if (item.staleMs && this.now() - item.updatedAt > item.staleMs) this.end(item.id, `${item.text}: stopped without saying it finished`, { failed: true });
    }
    const now = [...live, ...this.running.values()].map(({ id, text, done = null, total = null, since = null }) => ({ id, text, done, total, since }));
    return { now, recent: this.log.slice(0, SHOWN) };
  }

  #save() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 1000);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.log));
      fs.renameSync(tmp, this.file);
    } catch (err) { console.error(`Could not save the activity log: ${err.message}`); }
  }

  close() {
    for (const id of [...this.phones.keys()]) this.#phoneDone(id);
    this.flush();
  }
}

/** A source's name, or its folder's name, for the folder it's at. */
export function nameOfSource(library, folder) {
  return library.sources().find((s) => s.path === folder)?.name ?? path.basename(folder);
}

/** What the indexer is doing, for the status bar. `name` gives a source's name from its folder. */
export function indexingNow(status, name) {
  if (!status?.running) return [];
  const where = status.source ? name(status.source) : '';
  const progress = status.total ? ` · ${status.done.toLocaleString('en-US')} of ${status.total.toLocaleString('en-US')}` : '';
  const text = status.phase === 'scanning' ? `Looking for new photos in ${where}`
    : status.phase === 'comparing' ? `Looking for versions of the same photo${progress}`
    : `Importing from ${where}${progress}`;
  return [{ id: 'index', text, done: status.total ? status.done : null, total: status.total || null }];
}

/** Photos a phone is sending right now, and phone backups being exported. */
export function backupNow(uploads, backup, deviceName, destination) {
  const now = (uploads?.transfers ?? []).filter((t) => t.active).map((t) => ({
    id: `upload:${t.id}`, text: `${t.phase === 'verifying' ? 'Checking' : 'Receiving'} ${t.filename} from ${deviceName(t.deviceId)}`,
    done: t.bytesDone ?? null, total: t.totalBytes ?? null,
  }));
  if (backup?.running && backup.total) {
    now.push({ id: 'backup', text: `Exporting phone photos into ${destination ? tilde(destination) : 'the export folder'} · ${backup.done} of ${backup.total}`,
      done: backup.done, total: backup.total });
  }
  return now;
}

// Pure presentation model; the tray stays independent of renderer/window lifetime.
const bounded = (n) => Math.max(0, Math.min(1, n));
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.max(1, n)) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

export function syncStatus(status, serviceError = null) {
  if (!status) return { level: serviceError ? 'error' : 'starting', busy: true, progress: null,
    title: serviceError ? 'Host unavailable — retrying' : 'Starting Photobox…', detail: serviceError, counts: '' };
  const backup = status.backup ?? {};
  const transfers = (status.uploads?.transfers ?? []).filter((item) => item.active);
  const issue = backup.error || (backup.failed ? `${backup.failed} backup item(s) need attention` : null) ||
    (status.uploads?.failed ? `${status.uploads.failed} upload(s) failed integrity verification` : null);
  const counts = `${backup.received ?? 0} received · ${backup.indexed ?? 0} indexed · ${backup.exported ?? 0} export verified`;
  let title, progress = null, detail = issue, busy = false;
  if (transfers.length) {
    busy = true;
    const done = transfers.reduce((n, item) => n + item.bytesDone, 0);
    const total = transfers.reduce((n, item) => n + item.totalBytes, 0);
    progress = total ? bounded(done / total) : null;
    const phases = { receiving: 'Receiving', verifying: 'Verifying original', checking: 'Checking original', 'checking-export': 'Checking export' };
    title = transfers.length === 1 ? `${phases[transfers[0].phase] ?? 'Syncing'}: ${transfers[0].filename}` : `Syncing ${transfers.length} files`;
    detail = `${formatBytes(done)} of ${formatBytes(total)}${issue ? ` · ${issue}` : ''}`;
  } else if (status.indexing?.running) {
    busy = true;
    const { phase, done, total } = status.indexing;
    progress = phase !== 'scanning' && total ? bounded(done / total) : null;
    title = phase === 'scanning' ? 'Scanning photo folders…' : `Indexing ${done} of ${total}`;
  } else if (backup.running) {
    busy = true;
    progress = backup.total ? bounded(backup.done / backup.total) : null;
    title = backup.phase?.startsWith('export') ? `Exporting ${backup.done} of ${backup.total}` : `Checking library ${backup.done} of ${backup.total}`;
  } else if (issue) title = 'Backup needs attention';
  else if (!backup.configured && (backup.received ?? 0) > 0) title = 'Choose an export folder to finish backup';
  else if (backup.configured && (backup.received ?? 0) > (backup.exported ?? 0)) title = `${backup.received - backup.exported} original(s) awaiting export`;
  else if (status.uploads?.pending) title = `Waiting to resume ${status.uploads.pending} upload(s)`;
  else if (!status.network && !status.remote) title = 'Ready · phone access disabled';
  else title = 'Ready · all received photos export verified';
  return { level: issue ? 'error' : !backup.configured && backup.received > 0 ? 'warning' : busy ? 'syncing' : 'ready',
    busy, progress, title, detail, counts };
}

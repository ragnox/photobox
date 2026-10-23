// The page a phone opens from the QR code: trades the one-time code for a device token (kept as a cookie).
const $ = (sel) => document.querySelector(sel);

const code = location.hash.slice(1);
// Keep the code out of the browser history: it only works once anyway.
if (code) history.replaceState(null, '', location.pathname);

async function deviceName() {
  try {
    const { model } = await navigator.userAgentData.getHighEntropyValues(['model']);
    if (model) return model;
  } catch {
    // not available in this browser
  }
  return /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone';
}

/** Can this browser install Photobox as an app? Only if it trusts the connection. */
async function canInstall() {
  try {
    await navigator.serviceWorker.register('/sw.js');
    return true;
  } catch {
    return false;
  }
}

async function showConnected(ownCertificate) {
  $('#pair-form').hidden = true;
  $('#pair-done').hidden = false;
  const installable = await canInstall();
  $('#pair-cert').hidden = installable || !ownCertificate;
  $('#pair-install').hidden = !installable;
}

async function connect(e) {
  e.preventDefault();
  $('#pair-error').textContent = '';
  $('#pair-submit').disabled = true;
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: $('#pair-name').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    await showConnected(data.ownCertificate);
  } catch (err) {
    $('#pair-error').textContent = err.message;
    $('#pair-submit').disabled = false;
  }
}

if (code) {
  $('#pair-form').hidden = false;
  $('#pair-name').value = await deviceName();
  $('#pair-form').addEventListener('submit', connect);
} else if ((await fetch('/api/status').catch(() => null))?.ok) {
  // Already paired, e.g. back here after installing the certificate.
  await showConnected((await fetch('/photobox-ca.crt', { method: 'HEAD' }).catch(() => null))?.ok);
} else {
  $('#pair-nocode').hidden = false;
}

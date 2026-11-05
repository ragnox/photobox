// Drives the page in test/ui/electron.js the way a person would: real mouse clicks and key presses
// on what's visible, so a hidden or covered button fails the test.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DRIVER = fileURLToPath(new URL('./electron.js', import.meta.url));

/**
 * `desktop: true` gives the page the desktop app's preload, as in the app; `page.desktop` then records the
 * native menus it asks for and the files it reveals, and `page.desktop.answer(id)` picks the next menu item.
 */
export async function openPage({ profile, screenshots = null, desktop: asDesktop = false }) {
  const env = { ...process.env, PHOTOBOX_UI_PROFILE: profile, PHOTOBOX_UI_DESKTOP: asDesktop ? '1' : '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = { menus: [], revealed: [], answer: (id) => call('menuChoice', id) };
  const child = spawn(require('electron'), [DRIVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16_000); });
  const waiting = new Map();
  const errors = [];
  let nextId = 0;
  let ready;
  const started = new Promise((resolve, reject) => {
    ready = resolve;
    child.once('exit', (code) => reject(new Error(`Electron exited (${code})\n${stderr}`)));
    setTimeout(() => reject(new Error(`Electron didn't start\n${stderr}`)), 30_000).unref();
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.startsWith('@ui ')) return;
    const message = JSON.parse(line.slice(4));
    if (message.ready) ready();
    if (message.console?.level === 'error' || message.console?.level === 3) errors.push(message.console.message);
    if (message.menu) desktop.menus.push(message.menu);
    if (message.revealed) desktop.revealed.push(message.revealed);
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if ('error' in message) pending.reject(new Error(message.error));
    else pending.resolve(message.value);
  });
  child.once('exit', () => {
    for (const { reject } of waiting.values()) reject(new Error(`Electron exited\n${stderr}`));
  });
  await started;

  const call = (command, arg) => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, command, arg })}\n`);
  });

  /** Runs `fn(arg)` in the page and returns its (JSON) result. */
  const evaluate = (fn, arg) => call('eval', `(${fn})(${JSON.stringify(arg)})`);

  async function screenshot(name) {
    const dir = screenshots ?? await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-ui-'));
    const file = path.join(dir, `${name}.png`);
    // A hidden window paints lazily: wait for a fresh frame, or the picture can be of an earlier state.
    await evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await call('screenshot', file);
    return file;
  }

  /** Waits until `fn(arg)` returns something truthy in the page, and returns it. */
  async function waitFor(fn, arg, what = String(fn)) {
    const end = Date.now() + 10_000;
    for (;;) {
      const value = await evaluate(fn, arg);
      if (value) return value;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}\nScreenshot: ${await screenshot('timeout')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** The middle of the element, if it is what a click there would hit; else why not. */
  const target = (selector) => evaluate((sel) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : null;
    if (!el) return { missing: true };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const [x, y] = [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    const hit = document.elementFromPoint(x, y);
    if (!r.width || !r.height || !el.contains(hit)) return { hidden: true, covered: hit?.outerHTML.slice(0, 120) ?? null };
    return { x, y };
  }, selector);

  async function hover(selector) {
    const at = await waitFor((sel) => document.querySelector(sel), selector, selector).then(() => target(selector));
    if (at.missing || at.hidden) throw new Error(`Can't point at ${selector}: ${JSON.stringify(at)}`);
    await call('input', [{ type: 'mouseMove', x: at.x, y: at.y }]);
    return at;
  }

  /** A click in the middle of the element, e.g. click('.tile') or click('.tile', 'left', ['shift']). */
  async function click(selector, button = 'left', modifiers = []) {
    const end = Date.now() + 10_000;
    let at = await target(selector);
    while (at.missing || at.hidden) {
      if (Date.now() > end) throw new Error(`Can't click ${selector}: ${JSON.stringify(at)}\nScreenshot: ${await screenshot('click')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      at = await target(selector);
    }
    const { x, y } = at;
    await call('input', [
      { type: 'mouseMove', x, y, modifiers },
      { type: 'mouseDown', x, y, button, clickCount: 1, modifiers },
      { type: 'mouseUp', x, y, button, clickCount: 1, modifiers },
    ]);
  }

  /** A key press, e.g. key('i') or key('c', ['meta']). */
  async function key(keyCode, modifiers = []) {
    await call('input', [{ type: 'keyDown', keyCode, modifiers }, ...(modifiers.length ? [] : [{ type: 'char', keyCode }]), { type: 'keyUp', keyCode, modifiers }]);
  }

  return {
    errors,
    evaluate,
    waitFor,
    hover,
    click,
    rightClick: (selector) => click(selector, 'right'),
    key,
    desktop,
    screenshot,
    load: (address) => call('load', address),
    type: (text) => call('insertText', text),
    text: (selector) => evaluate((sel) => document.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() ?? null, selector),
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}

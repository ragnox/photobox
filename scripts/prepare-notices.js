// Collect redistribution notices from the exact installed production dependency set.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'build', 'licenses');
await fs.mkdir(out, { recursive: true });
for (const [name, url] of [
  ['GPL-3.0.txt', 'https://www.gnu.org/licenses/gpl-3.0.txt'],
  ['LGPL-3.0.txt', 'https://www.gnu.org/licenses/lgpl-3.0.txt'],
]) {
  try { await fs.access(path.join(out, name)); } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot retrieve ${name}`);
    await fs.writeFile(path.join(out, name), await response.text());
  }
}
await fs.copyFile(path.join(root, 'node_modules/electron/dist/LICENSE'), path.join(out, 'Electron-LICENSE.txt'));
await fs.copyFile(path.join(root, 'node_modules/electron/dist/LICENSES.chromium.html'), path.join(out, 'LICENSES.chromium.html'));
const npmOut = path.join(out, 'npm');
await fs.rm(npmOut, { recursive: true, force: true });
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const manifest = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || entry.dev || entry.devOptional) continue;
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(root, location, 'package.json'), 'utf8')); } catch { continue; }
  const folder = path.join(npmOut, `${pkg.name.replaceAll('/', '__')}-${pkg.version}`);
  await fs.mkdir(folder, { recursive: true });
  for (const file of await fs.readdir(path.join(root, location), { withFileTypes: true })) {
    if (file.isFile() && (/^(licen[cs]e|copying|notice)([.-]|$)/i.test(file.name) || file.name === 'package.json' || (pkg.name.startsWith('@img/') && ['README.md', 'versions.json'].includes(file.name)))) {
      await fs.copyFile(path.join(root, location, file.name), path.join(folder, file.name));
    }
  }
  manifest.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? null, repository: pkg.repository ?? null });
}
await fs.writeFile(path.join(out, 'production-dependencies.json'), `${JSON.stringify(manifest, null, 2)}\n`);

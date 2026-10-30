import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const arch = process.argv.includes('--x64') ? 'x64' : process.argv.includes('--arm64') ? 'arm64' : process.arch;
if (process.platform !== 'darwin') throw new Error('Build the DMG on macOS');
if (arch !== process.arch) throw new Error('Build/test each macOS architecture on a matching native runner');
const icons = spawnSync(process.execPath, ['scripts/make-tray-icons.js'], { cwd: root, stdio: 'inherit' });
if (icons.status) process.exit(icons.status);
const notices = spawnSync(process.execPath, ['scripts/prepare-notices.js'], { cwd: root, stdio: 'inherit' });
if (notices.status) process.exit(notices.status);
const signed = Boolean(process.env.CSC_LINK);
if (process.env.PHOTOBOX_REQUIRE_SIGNING === '1' && !signed) throw new Error('A Developer ID certificate (CSC_LINK) is required for this release');
const args = ['node_modules/electron-builder/cli.js', '--mac', `--${arch}`, '--publish', 'never'];
if (process.argv.includes('--dir')) args.push('--dir');
if (!signed) args.push('--config.mac.identity=-');
else args.push('--config.forceCodeSigning=true');
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: signed ? 'true' : 'false' } });
process.exit(result.status ?? 1);

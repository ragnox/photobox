import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const lines = [];
for (const file of process.argv.slice(2).sort()) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  lines.push(`${hash.digest('hex')}  ${path.basename(file)}`);
}
fs.writeFileSync('SHA256SUMS', `${lines.join('\n')}\n`);

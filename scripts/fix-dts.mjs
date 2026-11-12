// tsc rewrites `./x.ts` to `./x.js` in the emitted JavaScript but not in the declaration files; consumers resolve `./x.js`
// to `./x.d.ts`, so the declarations get the same specifiers.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const walk = dir => readdirSync(dir).flatMap(n => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
for (const file of walk(new URL('../dist', import.meta.url).pathname).filter(f => f.endsWith('.d.ts'))) {
  const text = readFileSync(file, 'utf8');
  const fixed = text.replace(/(from\s*['"]|import\(\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3');
  if (fixed !== text) writeFileSync(file, fixed);
}

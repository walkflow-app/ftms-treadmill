// Type-checks every ```ts example in README.md and docs/API.md against the sources, so the documentation cannot drift
// from the API. Each block becomes a module of its own in .docs-check/; docs/examples.d.ts declares the few names the
// examples take as given (`tm`, `adapter`). Run by `npm run check:docs` (and in CI).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, '.docs-check');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);

let count = 0;
for (const doc of ['README.md', 'docs/API.md']) {
  const text = readFileSync(join(root, doc), 'utf8');
  for (const m of text.matchAll(/^```ts\n([\s\S]*?)^```$/gm)) {
    const line = text.slice(0, m.index).split('\n').length;
    const name = `${doc.replace(/[/.]/g, '_')}_L${line}.ts`;
    writeFileSync(join(out, name), `// ${doc}:${line}\nexport {};\n${m[1]}`);
    count++;
  }
}

writeFileSync(join(out, 'tsconfig.json'), JSON.stringify({
  extends: '../tsconfig.json',
  compilerOptions: {
    types: ['web-bluetooth'],
    noUnusedLocals: false,
    paths: {
      'ftms-treadmill': ['../src/index.ts'],
      'ftms-treadmill/*': ['../src/*.ts'],
    },
  },
  include: ['*.ts', '../docs/examples.d.ts', '../examples/*.ts'],
}, null, 2));

try {
  execFileSync('npx', ['tsc', '--noEmit', '-p', join(out, 'tsconfig.json')], { stdio: 'inherit', cwd: root });
} catch {
  console.error('\nA documented example does not compile. The file name in .docs-check/ says where it is (doc and line).');
  process.exit(1);
}
console.log(`${count} examples in the docs compile.`);

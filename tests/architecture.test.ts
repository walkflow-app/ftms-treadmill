// The rules of the library's structure (docs/LIBRARY.md, "Packaging"), checked on the source files. A change that breaks
// one fails here, so the structure does not erode: the library stands on its own, only its Web Bluetooth adapter touches
// the browser, there are no cycles at runtime, and nothing but the four entry points is exported.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIB = join(ROOT, 'src');
/** The only ways into the library, as package.json exports them, and the source file of each */
const ENTRIES: Record<string, string> = {
  '.': 'index.ts',
  './web-bluetooth': 'web-bluetooth.ts',
  './sim': 'sim.ts',
  './protocol': 'protocol.ts',
};
/** The one file of the library that touches the browser */
const LIB_BROWSER = join(LIB, 'device', 'web-bluetooth.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

interface Import { spec: string; typeOnly: boolean }

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

function importsOf(text: string): Import[] {
  const out: Import[] = [];
  const re = /\b(import|export)(\s+type)?\s*(?:[^'";]*?\s+from\s*)?['"](\.{1,2}\/[^'"?]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"?]+)['"]\s*\)/g;
  for (const m of code(text).matchAll(re)) out.push({ spec: m[3] ?? m[4]!, typeOnly: m[2] !== undefined });
  return out;
}

/** Imports of packages (not relative paths), e.g. 'vitest' */
function packageImportsOf(text: string): Import[] {
  const out: Import[] = [];
  const re = /\b(import|export)(\s+type)?\s*(?:[^'";]*?\s+from\s*)?['"]([^'".][^'"?]*)['"]|\bimport\(\s*['"]([^'".][^'"?]*)['"]\s*\)/g;
  for (const m of code(text).matchAll(re)) out.push({ spec: m[3] ?? m[4]!, typeOnly: m[2] !== undefined });
  return out;
}

function resolveTs(from: string, spec: string): string | null {
  const base = normalize(join(dirname(from), spec));
  for (const candidate of [`${base}.ts`, base]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

const libFiles = walk(LIB).filter(p => p.endsWith('.ts'));
const libSources = libFiles.filter(p => !p.endsWith('.test.ts'));
const rel = (file: string) => relative(ROOT, file);

describe('library structure', () => {
  it('stands on its own: nothing outside src/, no texts, no other package', () => {
    const bad: string[] = [];
    for (const file of libFiles) {
      const text = readFileSync(file, 'utf8');
      for (const { spec } of importsOf(text)) {
        const target = resolveTs(file, spec);
        if (!target || !target.startsWith(LIB)) bad.push(`${rel(file)} → ${spec}`);
      }
      // Tests may use the test runner; the library itself has no dependencies
      for (const { spec } of packageImportsOf(text)) if (!(file.endsWith('.test.ts') && spec === 'vitest')) bad.push(`${rel(file)} → ${spec}`);
    }
    expect(bad).toEqual([]);
  });

  it('has no dependencies in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it('keeps the browser out, except in its Web Bluetooth adapter', () => {
    const found: string[] = [];
    for (const file of libSources.filter(f => f !== LIB_BROWSER)) {
      const hit = code(readFileSync(file, 'utf8')).replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''").match(/\b(document\.|window\.|localStorage|sessionStorage|indexedDB|navigator\.|HTMLElement|Bluetooth[A-Z]\w*)/);
      if (hit) found.push(`${rel(file)}: ${hit[0]}`);
    }
    expect(found).toEqual([]);
  });

  it('exports exactly the four entry points, each built from its source file', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, unknown> };
    const exported = Object.keys(pkg.exports).filter(k => k !== './package.json');
    expect(exported.sort()).toEqual(Object.keys(ENTRIES).sort());
    for (const [entry, file] of Object.entries(ENTRIES)) {
      const js = file.replace(/\.ts$/, '.js');
      expect(pkg.exports[entry], entry).toEqual({ types: `./dist/${file.replace(/\.ts$/, '.d.ts')}`, import: `./dist/${js}` });
      expect(statSync(join(LIB, file)).isFile(), file).toBe(true);
    }
  });

  it('has no import cycles at runtime (a type-only import does not count)', () => {
    const graph = new Map<string, string[]>();
    for (const file of libSources) {
      const deps = importsOf(readFileSync(file, 'utf8')).filter(i => !i.typeOnly).map(i => resolveTs(file, i.spec)).filter((p): p is string => !!p && p.startsWith(LIB));
      graph.set(file, deps);
    }
    const cycles: string[] = [];
    const state = new Map<string, 1 | 2>();
    const stack: string[] = [];
    const visit = (f: string) => {
      state.set(f, 1);
      stack.push(f);
      for (const d of graph.get(f) ?? []) {
        if (state.get(d) === 1) cycles.push([...stack.slice(stack.indexOf(d)), d].map(rel).join(' → '));
        else if (!state.has(d)) visit(d);
      }
      stack.pop();
      state.set(f, 2);
    };
    for (const f of graph.keys()) if (!state.has(f)) visit(f);
    expect(cycles).toEqual([]);
  });

  it('keeps a test next to the code it tests', () => {
    const orphans = libFiles.filter(p => p.endsWith('.test.ts')).filter(t => !statSync(t.replace(/\.test\.ts$/, '.ts'), { throwIfNoEntry: false })?.isFile());
    expect(orphans.map(rel)).toEqual([]);
  });
});

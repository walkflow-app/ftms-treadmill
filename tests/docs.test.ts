// The API reference (docs/API.md) covers everything the library offers: every export of every entry point, every method of
// the treadmill, every event, every notice code and every simulator option. Something new without its documentation fails
// here. That the examples compile is checked by scripts/check-docs.mjs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTreadmill } from '../src/index.ts';
import { SimulatorAdapter } from '../src/sim.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const API = read('docs/API.md');
const documented = (name: string) => API.includes(`\`${name}`);

/** Names in `export { a, type B } from '…'` lists */
function exportList(file: string): string[] {
  const names: string[] = [];
  for (const m of read(file).matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '');
      if (name) names.push(name);
    }
  }
  return names;
}

/** Names declared with `export const|function|interface|type|class` */
function declaredExports(file: string): string[] {
  return [...read(file).matchAll(/^export\s+(?:const|function|interface|type|class)\s+(\w+)/gm)].map(m => m[1]!);
}

/** The keys of an interface in a source file */
function interfaceKeys(file: string, name: string): string[] {
  const text = read(file);
  const start = text.indexOf(`export interface ${name} {`);
  const body = text.slice(start, text.indexOf('\n}', start));
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map(m => m[1]!);
}

describe('API reference', () => {
  it('documents every export of every entry point', () => {
    const names = [
      ...exportList('src/index.ts'),
      ...exportList('src/sim.ts'),
      ...exportList('src/web-bluetooth.ts'),
      ...declaredExports('src/protocol/ftms.ts'),
    ];
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter(n => !documented(n))).toEqual([]);
  });

  it('documents every method and property of the treadmill', () => {
    const tm = createTreadmill();
    const members = Object.keys(Object.getOwnPropertyDescriptors(tm));
    expect(members).toContain('state');
    expect(members.filter(m => !API.includes(`\`tm.${m}`))).toEqual([]);
  });

  it('documents every event', () => {
    const events = interfaceKeys('src/device/treadmill.ts', 'TreadmillEventMap');
    expect(events.length).toBeGreaterThan(10);
    expect(events.filter(e => !API.includes(`| \`${e}\` |`))).toEqual([]);
  });

  it('documents every field of the state', () => {
    const fields = Object.keys(createTreadmill().state);
    expect(fields.filter(f => !documented(f))).toEqual([]);
  });

  it('documents every notice code', () => {
    const codes = [...new Set([...read('src/protocol/notice.ts').matchAll(/code: '([a-z-]+)'/g)].map(m => m[1]!))];
    expect(codes.length).toBeGreaterThan(20);
    expect(codes.filter(c => !API.includes(`'${c}'`) && !documented(c))).toEqual([]);
  });

  it('documents every simulator option', () => {
    const sim = new SimulatorAdapter();
    const options = Object.keys(sim.opts);
    sim.dispose();
    expect(options.filter(o => !documented(o))).toEqual([]);
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as evidence from '../../packages/registry-evidence/src/index.js';
import * as breg from '../../packages/registry-breg/src/index.js';
import * as http from '@openfn/language-http';

const rootRequire = createRequire(import.meta.url);

function dependency(parentRequire, name) {
  let directory = dirname(parentRequire.resolve(name));
  while (true) {
    try {
      const manifestPath = join(directory, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name === name) return { manifest, require: createRequire(manifestPath) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot find package manifest for ${name}`);
    directory = parent;
  }
}

for (const [name, adaptor, parentRequire] of [
  ['Evidence', evidence, createRequire(new URL('../../packages/registry-evidence/package.json', import.meta.url))],
  ['BREG', breg, createRequire(new URL('../../packages/registry-breg/package.json', import.meta.url))],
  ['HTTP', http, dependency(rootRequire, '@openfn/language-http').require],
]) {
  test(`${name} common CSV operations remain compatible with the scoped parser override`, async () => {
    const common = dependency(parentRequire, '@openfn/language-common');
    assert.equal(typeof adaptor.parseCsv, 'function');
    const csv = '\uFEFFname,value\n "Synthetic, Farm" , 42 \n\nSecond, 7\n';
    const expected = [{ name: 'Synthetic, Farm', value: '42' }, { name: 'Second', value: '7' }];
    const result = await adaptor.parseCsv(csv)({ data: {}, configuration: {} });
    assert.deepEqual(result.data, expected);

    const chunks = [];
    const streamed = await adaptor.parseCsv(Readable.from([csv.slice(0, 20), csv.slice(20)]), { chunkSize: 1 }, (state, records) => {
      chunks.push(records);
      return { ...state, rows: [...state.rows, ...records] };
    })({ data: {}, configuration: {}, rows: [] });
    assert.deepEqual(streamed.rows, expected);
    assert.deepEqual(chunks, expected.map(row => [row]));

    // Exercise the actual parser selected for this common package, including its ESM API.
    const parserRequire = dependency(common.require, 'csv-parse').require;
    const { parse } = await import(pathToFileURL(join(dirname(parserRequire.resolve('csv-parse')), '../../lib/index.js')));
    const records = [];
    for await (const record of parse('__proto__,__proto__,name\nfirst,second,synthetic\n', { columns: true, group_columns_by_name: true })) records.push(record);
    assert.equal(records.length, 1);
    assert.equal(Object.getPrototypeOf(records[0]), Object.prototype);
    assert.equal(Object.hasOwn(records[0], '__proto__'), true);
    assert.deepEqual(records[0].__proto__, ['first', 'second']);
    assert.equal(records[0][0], undefined);
    assert.equal(records[0].name, 'synthetic');
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, validateManifest, segmentsForRange, CAP } from '../src/range.mjs';
const m = validateManifest({ filename: 'test.mp4', parts: [
  { channel: '@publicoteste', messageId: 1, size: 536870912 },
  { channel: '@publicoteste', messageId: 2, size: 1000 },
]});
test('manifesto soma duas partes sem lacunas', () => { assert.equal(m.size, 536871912); assert.equal(m.parts[1].offset, 536870912); });
test('HEAD sem Range informa tamanho inteiro', () => assert.deepEqual(parseRange(null, m.size), { start: 0, end: m.size - 1, partial: false }));
test('Range parcial com teto', () => assert.deepEqual(parseRange('bytes=0-', m.size), { start: 0, end: CAP-1, partial: true }));
test('Range final e suffix', () => assert.deepEqual(parseRange('bytes=-12', m.size), { start: m.size-12, end: m.size-1, partial: true }));
test('Range invalido', () => { assert.equal(parseRange('bytes=999999999999-', m.size), null); assert.equal(parseRange('bytes=0-4,8-9', m.size), null); });
test('Range cruza fronteira entre mensagens', () => {
  const x = segmentsForRange(m, 536870900, 536870930);
  assert.equal(x.length, 2); assert.equal(x[0].end-x[0].start+1, 12); assert.equal(x[1].end-x[1].start+1, 19);
});
test('Manifesto bloqueia partes maiores que 512 MiB', () => assert.throws(() => validateManifest({filename:'test.mp4',parts:[{channel:'@publicoteste', messageId:1,size:536870913}]})));

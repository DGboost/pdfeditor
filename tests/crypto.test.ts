import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { randomUUID, sha256Hex } from '../src/utils/crypto';
import { downloadCatalogFont, getCatalogFace, verifyFontAsset } from '../src/pdf/fontCatalog';

test('HTTP crypto preserves UUID v4 and SHA-256 document/font integrity without secure-context APIs', async t => {
  const nativeCrypto = globalThis.crypto;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', descriptor));

  assert.equal(await sha256Hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const pdf = new Uint8Array(await readFile(new URL('../test.pdf', import.meta.url)));
  const expected = createHash('sha256').update(pdf).digest('hex');
  assert.equal(await sha256Hex(pdf), expected);
  const font = new Uint8Array(await readFile(new URL('../src/assets/fonts/nanumgothic/NanumGothic-Regular.ttf', import.meta.url)));
  const asset = await downloadCatalogFont(getCatalogFace('nanumgothic-regular')!, async () => font);
  assert.deepEqual(await verifyFontAsset(asset), font);
  const corrupted = font.slice(); corrupted[corrupted.length - 1] ^= 1;
  await assert.rejects(verifyFontAsset({ ...asset, bytes: new Blob([corrupted]) }), /무결성/);

  Object.defineProperty(globalThis, 'crypto', descriptor);
  assert.equal(await sha256Hex(pdf), expected, 'HTTPS and HTTP hashes must address the same saved document');
});

test('native SHA-256 failures are not hidden by the HTTP fallback', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  const failure = new Error('digest failed');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async () => { throw failure; } } } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', descriptor));
  await assert.rejects(sha256Hex(new Uint8Array()), error => error === failure);
});

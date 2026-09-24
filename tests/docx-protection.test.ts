import test from 'node:test';
import assert from 'node:assert/strict';
import { isEnforcedProtection } from '../engines/docx/protection';

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const attribute = (localName: string, value: string) => ({
  name: `w:${localName}`, localName, value, namespaceURI: wordNamespace, prefix: 'w',
});
const namespaceDeclaration = {
  name: 'xmlns:w', localName: 'w', value: wordNamespace,
  namespaceURI: 'http://www.w3.org/2000/xmlns/', prefix: 'xmlns',
};

test('absent protection and unrelated settings do not restrict editing', () => {
  assert.equal(isEnforcedProtection('settings', []), false);
  assert.equal(isEnforcedProtection('zoom', [attribute('enforcement', '1')]), false);
});

test('bare write protection remains enforced, with or without a namespace declaration', () => {
  assert.equal(isEnforcedProtection('writeProtection', []), true);
  assert.equal(isEnforcedProtection('writeProtection', [namespaceDeclaration]), true);
});

test('recommended-only write protection is advisory, including local namespace declarations', () => {
  const recommended = attribute('recommended', '1');
  assert.equal(isEnforcedProtection('writeProtection', [recommended]), false);
  assert.equal(isEnforcedProtection('writeProtection', [namespaceDeclaration, recommended]), false);
});

test('only Word recommended attributes can make write protection advisory', () => {
  const recommended = attribute('recommended', '1');
  const foreign = { ...recommended, name: 'ext:recommended', prefix: 'ext', namespaceURI: 'urn:extension' };
  assert.equal(isEnforcedProtection('writeProtection', [foreign]), true);
  assert.equal(isEnforcedProtection('writeProtection', [recommended, foreign]), true);
  assert.equal(isEnforcedProtection('writeProtection', [
    { ...recommended, name: 'word:recommended', prefix: 'word' },
  ]), false);
  assert.equal(isEnforcedProtection('writeProtection', [
    { ...recommended, name: 'recommended', prefix: null, namespaceURI: null },
  ]), true);
});

test('password material enforces write protection even when recommended is present', () => {
  const hash = attribute('hashValue', 'AQID');
  assert.equal(isEnforcedProtection('writeProtection', [hash]), true);
  assert.equal(isEnforcedProtection('writeProtection', [attribute('recommended', '1'), hash]), true);
});

test('formatting restrictions cannot override disabled or absent enforcement', () => {
  const formatting = attribute('formatting', '1');
  assert.equal(isEnforcedProtection('documentProtection', [formatting]), false);
  for (const value of ['0', 'false', 'off']) {
    assert.equal(isEnforcedProtection('documentProtection', [formatting, attribute('enforcement', value)]), false);
  }
  assert.equal(isEnforcedProtection('documentProtection', [formatting, attribute('enforcement', '1')]), true);
});

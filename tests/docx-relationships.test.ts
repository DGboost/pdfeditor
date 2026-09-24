import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldWarnExternalRelationship } from '../engines/docx/relationships';

const prefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

test('external links and attached templates do not report missing media', () => {
  for (const type of ['hyperlink', 'attachedTemplate']) {
    assert.equal(shouldWarnExternalRelationship('External', prefix + type), false);
  }
});

test('external images and unknown or missing relationship types retain warnings', () => {
  for (const type of [prefix + 'image', 'urn:vendor:unknown', null]) {
    assert.equal(shouldWarnExternalRelationship('External', type), true);
  }
});

test('internal or unspecified targets never report blocked external resources', () => {
  for (const mode of ['Internal', null]) {
    assert.equal(shouldWarnExternalRelationship(mode, prefix + 'image'), false);
  }
});

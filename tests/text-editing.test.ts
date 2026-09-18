import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRunStyle, defaultTextStyle, graphemeRange, normalizeInput, normalizeRuns, plainText, reconcileInput, spliceRuns } from '../src/pdf/textEditing';
import type { StyledRun, TextStyle } from '../src/types/pdfEditor';

const regular = defaultTextStyle();
const bold: TextStyle = { ...regular, font: { kind: 'bundled', family: 'NanumGothic', bold: true } };
const colored: TextStyle = { ...regular, color: [1, 0, 0] };

test('inserting a repeated character at the captured start inherits that location, not the common suffix', () => {
  const source: StyledRun[] = [{ text: 'a', style: bold }, { text: 'a', style: regular }];
  const result = reconcileInput(source, { start: 0, end: 0, inputType: 'insertText' }, 'aaa');
  assert.deepEqual(result, [{ text: 'aa', style: bold }, { text: 'a', style: regular }]);
  assert.deepEqual(source, [{ text: 'a', style: bold }, { text: 'a', style: regular }]);
});

test('insertion at a style boundary inherits the right run, while insertion at the end inherits the left', () => {
  const source: StyledRun[] = [{ text: 'a', style: bold }, { text: 'a', style: regular }];
  assert.deepEqual(spliceRuns(source, 1, 1, 'x'), [{ text: 'a', style: bold }, { text: 'xa', style: regular }]);
  assert.deepEqual(spliceRuns(source, 2, 2, 'x'), [{ text: 'a', style: bold }, { text: 'ax', style: regular }]);
});

test('backspace and forward delete at the same boundary remove different repeated characters and their styles', () => {
  const source: StyledRun[] = [{ text: 'a', style: bold }, { text: 'a', style: regular }];
  assert.deepEqual(reconcileInput(source, { start: 1, end: 1, inputType: 'deleteContentBackward' }, 'a'), [{ text: 'a', style: regular }]);
  assert.deepEqual(reconcileInput(source, { start: 1, end: 1, inputType: 'deleteContentForward' }, 'a'), [{ text: 'a', style: bold }]);
});

test('replacing an unchanged plain string still applies the replacement caret style across the selection', () => {
  const source: StyledRun[] = [{ text: 'a', style: bold }, { text: 'a', style: regular }];
  assert.deepEqual(reconcileInput(source, { start: 0, end: 2, inputType: 'insertText' }, 'aa'), [{ text: 'aa', style: bold }]);
});

test('replacing a selection across runs preserves both unaffected sides and replacement formatting', () => {
  const source: StyledRun[] = [{ text: 'ab', style: bold }, { text: 'cd', style: colored }];
  assert.deepEqual(reconcileInput(source, { start: 1, end: 3, inputType: 'insertText' }, 'aXd'), [
    { text: 'aX', style: bold }, { text: 'd', style: colored },
  ]);
});

test('a Korean composition is reconciled against its original anchor and normalized without changing neighboring runs', () => {
  const source: StyledRun[] = [{ text: '가', style: bold }, { text: '가', style: regular }];
  const browserValue = '각가가';
  const composing = reconcileInput(source, { start: 0, end: 0, inputType: 'insertCompositionText' }, browserValue);
  assert.deepEqual(normalizeRuns(composing), [{ text: '각가', style: bold }, { text: '가', style: regular }]);
  assert.deepEqual(normalizeInput(browserValue, 3, 4), { text: '각가가', start: 1, end: 2 });
});

test('NFC, tabs and CRLF normalization remap selection offsets to the normalized textarea value', () => {
  const value = '가\tB\r\nC';
  assert.deepEqual(normalizeInput(value, 2, 6), { text: '가    B\nC', start: 1, end: 7 });
  assert.deepEqual(normalizeInput(value, 3, 7), { text: '가    B\nC', start: 5, end: 8 });
  assert.deepEqual(normalizeRuns([{ text: value, style: colored }]), [{ text: '가    B\nC', style: colored }]);
});

test('partial surrogate or combining-mark selections expand to complete graphemes for replacement and formatting', () => {
  const source: StyledRun[] = [{ text: 'A😀e\u0301Z', style: regular }];
  assert.deepEqual(graphemeRange(plainText(source), 2, 4), { start: 1, end: 5 });
  assert.deepEqual(spliceRuns(source, 2, 4, 'X'), [{ text: 'AXZ', style: regular }]);
  assert.deepEqual(applyRunStyle(source, 4, 5, { color: [1, 0, 0] }), [
    { text: 'A😀', style: regular },
    { text: 'e\u0301', style: { ...regular, color: [1, 0, 0] } },
    { text: 'Z', style: regular },
  ]);
});

test('a ZWJ emoji sequence cannot be partially deleted', () => {
  const family = '👨‍👩‍👧‍👦';
  const source: StyledRun[] = [{ text: `A${family}B`, style: bold }];
  assert.deepEqual(spliceRuns(source, 3, 4, ''), [{ text: 'AB', style: bold }]);
});

test('range formatting does not spread to identical adjacent text and preserves other style properties', () => {
  const source: StyledRun[] = [{ text: 'aaa', style: colored }];
  assert.deepEqual(applyRunStyle(source, 1, 2, { font: bold.font, sizePt: 18 }), [
    { text: 'a', style: colored },
    { text: 'a', style: { ...colored, font: bold.font, sizePt: 18 } },
    { text: 'a', style: colored },
  ]);
});

test('formatting an empty target survives subsequent typing, and literal markup remains text', () => {
  const empty = applyRunStyle([{ text: '', style: regular }], 0, 0, { font: bold.font });
  const literal = '<img src=x onerror=alert(1)>';
  assert.deepEqual(spliceRuns(empty, 0, 0, literal), [{ text: literal, style: bold }]);
});

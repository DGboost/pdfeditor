import assert from 'node:assert/strict';
import test from 'node:test';
import type { RegionConfig, RegionMapping } from '../src/documents/regionTypes';
import type { RenderedPage, SourceTextLine, SourceTextPage } from '../src/pdf/engineTypes';
import type { PdfPage } from '../src/types/pdfEditor';
import { eligibility } from '../src/components/screens/EditorScreen/PdfRegionScreen';

const style = { font: { kind: 'bundled' as const, family: 'NanumGothic' as const, bold: false }, sizePt: 12, color: [0, 0, 0] as [number, number, number] };
function line(lineId: string, painted: [number, number, number, number]): SourceTextLine {
  return { lineId, text: lineId, bounds: [0, 0, 30, 12], origin: [0, 0], direction: [1, 0], writingMode: 0,
    chars: [{ text: lineId, quad: [painted[0], painted[1], painted[2], painted[1], painted[0], painted[3], painted[2], painted[3]], origin: [0, 0], fontKey: 'f', sizePt: 12, color: [0, 0, 0], paintBounds: painted }],
    content: { runs: [{ text: lineId, style }], align: 'left' }, widthPt: 30, editable: true };
}
function mapping(page: PdfPage, member: SourceTextLine, role: RegionMapping['role']): RegionMapping {
  return { id: `${page.id}:${member.lineId}`, role, anchor: { kind: 'pdf', pageId: page.id, sourcePageIndex: page.sourcePageIndex, lineIds: [member.lineId], originalText: member.text }, currentText: member.text };
}
const page: PdfPage = { kind: 'pdf', id: 'instance-1', label: '1', sourcePageIndex: 0, originalInstance: true, rotation: 0, textEdits: [] };
const student = line('student', [0, 0, 5, 8]);
const target = { kind: 'source' as const, lineIds: [student.lineId], bounds: student.bounds, quads: [], content: student.content, widthPt: student.widthPt, editable: true };

test('unmapped or explicitly protected painted glyph overlapping a mapped line vetoes its card', () => {
  const teacher = line('teacher', [4, 0, 10, 8]);
  const source: SourceTextPage = { sourcePageIndex: 0, lines: [student, teacher] };
  const editable = { reviewed: true, mappings: [mapping(page, student, 'studentName')] } as RegionConfig;
  assert.notEqual(eligibility(page, student, target, source, editable), null);
  const protectedConfig = { ...editable, mappings: [...editable.mappings, mapping(page, teacher, 'locked')] };
  assert.notEqual(eligibility(page, student, target, source, protectedConfig), null);
});

test('nearby line metric rectangles alone do not block independent painted glyphs', () => {
  const teacher = line('teacher', [5, 0, 10, 8]);
  const source: SourceTextPage = { sourcePageIndex: 0, lines: [student, teacher] };
  const config = { reviewed: true, mappings: [mapping(page, student, 'studentName'), mapping(page, teacher, 'locked')] } as RegionConfig;
  assert.equal(eligibility(page, student, target, source, config), null);
});

test('page-instance anchors and confirmed text cannot authorize a different target', () => {
  const source: SourceTextPage = { sourcePageIndex: 0, lines: [student] };
  const config = { reviewed: true, mappings: [mapping(page, student, 'studentName')] } as RegionConfig;
  assert.notEqual(eligibility({ ...page, id: 'instance-2' }, student, target, source, config), null);
  assert.notEqual(eligibility(page, student, { ...target, content: { ...target.content, runs: [{ text: 'changed', style }] } }, source, config), null);
  assert.equal(eligibility(page, student, target, source, config), null);
});

test('edited protected line uses its native rendered target and refuses unresolved geometry', () => {
  const teacher = line('teacher', [15, 0, 20, 8]);
  const source: SourceTextPage = { sourcePageIndex: 0, lines: [student, teacher] };
  const editedPage = { ...page, textEdits: [{ lineIds: [teacher.lineId], content: teacher.content, widthPt: 30 }] };
  const config = { reviewed: true, mappings: [mapping(page, student, 'studentName'), mapping(page, teacher, 'locked')] } as RegionConfig;
  const render: RenderedPage = { rgba: new Uint8ClampedArray(0), width: 1, height: 1, pixelOrigin: [0, 0], pageToRaster: [1, 0, 0, 1, 0, 0], bounds: [0, 0, 30, 12], displayBounds: [0, 0, 30, 12], textTargets: [{ ...target, lineIds: [teacher.lineId], bounds: [3, 0, 8, 8] }] };
  assert.notEqual(eligibility(editedPage, student, target, source, config), null);
  assert.notEqual(eligibility(editedPage, student, target, source, config, render), null);
});

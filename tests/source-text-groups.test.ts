import assert from 'node:assert/strict';
import test from 'node:test';
import { documentReducer, initialDocumentState } from '../src/hooks/useDocumentReducer';
import { createNativePdfApi } from '../src/pdf/nativeDocument';
import { buildSourceTextGroup, type SourceTextGroup } from '../src/pdf/sourceTextGroups';
import type { SourceTextLine, SourceTextPage } from '../src/pdf/engineTypes';
import type { PdfPage, SourceTextEdit, TextContent } from '../src/types/pdfEditor';
import { normalizePdfDraft } from '../src/utils/db';
import { adjacentColorSpanFixture, directRender, extractedText, loadFont, mupdf, pdfPage, saved, textContent, workspace } from './fixtures';

// Authored PDF operators, not the editor's layout engine, define fixture geometry.
function fixture(options: { middle?: boolean; columns?: boolean; clip?: boolean; rotate?: number; list?: 'continuation' | 'separate' } = {}): Uint8Array {
  const pdf = new mupdf.PDFDocument(); const font = new mupdf.Font('Helvetica');
  try {
    const draw = (text: string, x: number, y: number) => `BT /F0 12 Tf 0 0 0 rg 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET\n`;
    let stream = '0.92 0.96 0.87 rg 0 0 420 420 re f\n';
    if (options.clip) stream += 'q 30 310 220 65 re W n\n';
    stream += draw(`${options.list ? '1. ' : ''}Alpha beta gamma delta`, 40, 350);
    if (options.middle) stream += draw('Middle row must remain', 40, 332);
    stream += draw(`${options.list === 'separate' ? '2. ' : ''}Epsilon zeta eta theta`, options.columns ? 250 : options.list === 'continuation' ? 52 : 40, options.columns ? 350 : options.middle ? 314 : 332);
    if (options.clip) stream += 'Q\n';
    stream += draw('Outside neighbor 123', 40, 170);
    pdf.insertPage(-1, pdf.addPage([0, 0, 420, 420], options.rotate ?? 0, { Font: { F0: pdf.addSimpleFont(font) } }, stream));
    return saved(pdf);
  } finally { font.destroy(); pdf.destroy(); }
}
function selected(source: SourceTextPage): string[] {
  return ['Alpha beta gamma delta', 'Epsilon zeta eta theta'].map(text => {
    const line = source.lines.find(line => line.text === text); assert.ok(line, text); assert.equal(line.editable, true, line.reason); return line.lineId;
  });
}
function replacement(content: TextContent, text: string): TextContent {
  return { ...content, runs: [{ text, style: content.runs[0].style }] };
}
function editFrom(group: SourceTextGroup): SourceTextEdit {
  return { lineIds: group.lineIds, content: group.content, widthPt: group.widthPt, layout: group.layout };
}

// Writer spans are not visual rows. Project actual glyph baselines along the
// native writing direction so rotation and per-glyph font spans cannot split rows.
function visualRows(lines: SourceTextLine[]): Array<{ baseline: number; text: string }> {
  const rows = new Map<number, Array<{ along: number; text: string }>>();
  for (const line of lines) {
    const [dx, dy] = line.direction;
    for (const char of line.chars) {
      const [x, y] = char.origin;
      const baseline = Math.round((-dy * x + dx * y) * 100) / 100;
      const row = rows.get(baseline) ?? [];
      row.push({ along: dx * x + dy * y, text: char.text });
      rows.set(baseline, row);
    }
  }
  return [...rows].sort(([a], [b]) => a - b).map(([baseline, glyphs]) => ({
    baseline, text: glyphs.sort((a, b) => a.along - b.along).map(glyph => glyph.text).join(''),
  }));
}

test('manual group sorts reversed selection, uses current styles and preserves hard breaks and literal hyphens', async () => {
  const bytes = fixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)])); const source = await api.text(0); const ids = selected(source); const page = pdfPage(0);
    const first = source.lines.find(line => line.lineId === ids[0])!;
    const second = source.lines.find(line => line.lineId === ids[1])!;
    const styled = { ...first.content.runs[0].style, color: [1, 0, 0] as [number, number, number] };
    page.textEdits = [
      { lineIds: [ids[0]], widthPt: first.widthPt, content: { align: 'left', runs: [{ text: 'Current-\nexplicit ', style: styled }] } },
      { lineIds: [ids[1]], widthPt: second.widthPt, content: replacement(second.content, 'second edit') },
    ];
    const group = buildSourceTextGroup(page, source, [...ids].reverse());
    assert.deepEqual(group.lineIds, ids);
    assert.equal(group.content.runs.map(run => run.text).join(''), 'Current-\nexplicit second edit');
    assert.deepEqual(group.content.runs.find(run => run.text.includes('Current-'))!.style, styled);
    assert.deepEqual(group.content.runs.find(run => run.text.includes('second edit'))!.style, second.content.runs[0].style);
    assert.equal(group.layout.lineHeightPt, 18); assert.equal(group.layout.referenceSizePt, 12);
    assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes, 'Selection and group construction never commit source changes');
    const groupedPage = { ...page, textEdits: [editFrom(group)] };
    assert.deepEqual(buildSourceTextGroup(groupedPage, source, ids).content, group.content, 'Reopening does not rejoin or lose explicit breaks');
    assert.throws(() => buildSourceTextGroup(groupedPage, source, [ids[0], source.lines.find(line => line.text === 'Outside neighbor 123')!.lineId]));
  } finally { api.close(); }
});

test('adjacent same-row source spans retain both colors without an invented space', async () => {
  const bytes = adjacentColorSpanFixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)])); const source = await api.text(0);
    const group = buildSourceTextGroup(pdfPage(0), source, source.lines.map(line => line.lineId).reverse());
    assert.equal(group.content.runs.map(run => run.text).join(''), 'HHHHHHHH');
    assert.deepEqual(group.content.runs.map(run => run.style.color), [[0, 0, 0], [1, 0, 0]]);
    const page = { ...pdfPage(0), textEdits: [editFrom(group)] };
    assert.deepEqual(await api.validate(page), { ok: true });
    const out = await api.export(workspace(bytes, [page]));
    assert.equal(extractedText(out).replace(/\s/g, ''), 'HHHHHHHH');
  } finally { api.close(); }
});

test('explicit group hard breaks survive export and font-size changes scale measured leading', async () => {
  const bytes = fixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)])); const source = await api.text(0); const group = buildSourceTextGroup(pdfPage(0), source, selected(source));
    const content: TextContent = { ...group.content, runs: [{ text: 'Alpha\nBeta', style: { ...group.content.runs[0].style, sizePt: 18, color: [0, 0, 1] } }] };
    const page = { ...pdfPage(0), textEdits: [{ ...editFrom(group), content }] };
    assert.deepEqual(await api.validate(page), { ok: true });
    const out = await api.export(workspace(bytes, [page]));
    const reopened = createNativePdfApi(loadFont, () => {});
    try {
      await reopened.open(new Blob([Uint8Array.from(out)]));
      const lines = (await reopened.text(0)).lines.filter(line => line.text !== 'Outside neighbor 123');
      const rows = visualRows(lines);
      assert.deepEqual(rows.map(row => row.text), ['Alpha', 'Beta']);
      assert.ok(Math.abs(rows[1].baseline - rows[0].baseline - 27) < 0.01);
      assert.ok(lines.every(line => line.content.runs.every(run => run.style.sizePt === 18 && run.style.color[2] === 1)));
    } finally { reopened.close(); }
  } finally { api.close(); }
});

for (const unsafe of ['columns', 'middle', 'direction'] as const) {
  test(`manual grouping rejects ${unsafe} without changing original bytes`, async () => {
    const bytes = fixture({ columns: unsafe === 'columns', middle: unsafe === 'middle' }); const api = createNativePdfApi(loadFont, () => {});
    try {
      await api.open(new Blob([Uint8Array.from(bytes)])); const source = await api.text(0); const ids = selected(source); const page = pdfPage(0);
      const candidate = unsafe === 'direction' ? { ...source, lines: source.lines.map(line => line.lineId === ids[1] ? { ...line, direction: [0, 1] as [number, number] } : line) } : source;
      assert.throws(() => buildSourceTextGroup(page, candidate, ids));
      assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    } finally { api.close(); }
  });
}

for (const rotate of [0, 90]) {
  test(`native grouped growth and shrink retain source font, neighbors, background and ${rotate}-degree page geometry`, async () => {
    const bytes = fixture({ rotate }); const api = createNativePdfApi(loadFont, () => {});
    try {
      const info = await api.open(new Blob([Uint8Array.from(bytes)])); const source = await api.text(0); const group = buildSourceTextGroup(pdfPage(0), source, selected(source));
      assert.equal(group.content.runs.map(run => run.text).join(''), 'Alpha beta gamma delta Epsilon zeta eta theta');
      const font = group.content.runs[0].style.font; assert.equal(font.kind, 'source');
      for (const value of ['Alpha beta gamma delta Epsilon zeta eta theta Alpha beta gamma delta Epsilon zeta eta theta', 'Short']) {
        const edit = { ...editFrom(group), content: replacement(group.content, value) }; const page = { ...pdfPage(0), textEdits: [edit] };
        assert.deepEqual(await api.validate(page), { ok: true });
        const preview = await api.render(page, 1); const targets = preview.textTargets.filter(target => target.kind === 'source' && target.lineIds.some(id => group.lineIds.includes(id)));
        assert.equal(targets.length, 1); assert.equal(targets[0].kind, 'source');
        if (targets[0].kind !== 'source') assert.fail('Expected grouped source target');
        assert.deepEqual(targets[0].lineIds, group.lineIds); assert.deepEqual(targets[0].content, edit.content); assert.equal(targets[0].widthPt, group.widthPt);
        const out = await api.export(workspace(bytes, [page])); const text = extractedText(out);
        assert.equal(text.replace('Outside neighbor 123', '').replace(/\s+/g, ' ').trim(), value, 'Only one replacement remains'); assert.ok(text.includes('Outside neighbor 123'));
        const raster = directRender(out); assert.deepEqual(preview.rgba, raster.rgba);
        const baseline = directRender(bytes); assert.equal(raster.width, baseline.width); assert.equal(raster.height, baseline.height);
        if (rotate === 0) {
          for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
            if (x >= 38 && x <= 190 && y >= 55 && y <= 180) continue;
            const offset = (y * raster.width + x) * 4;
            assert.deepEqual(raster.rgba.subarray(offset, offset + 4), baseline.rgba.subarray(offset, offset + 4), `Outside pixel ${x},${y}`);
          }
          if (value === 'Short') {
            const green = baseline.rgba.subarray(0, 4);
            for (let y = 77; y <= 94; y++) for (let x = 40; x <= 170; x++) {
              const offset = (y * raster.width + x) * 4;
              assert.deepEqual(raster.rgba.subarray(offset, offset + 4), green, `Vacated second-row background ${x},${y}`);
            }
          }
        }
        const reopened = createNativePdfApi(loadFont, () => {});
        try {
          const after = await reopened.open(new Blob([Uint8Array.from(out)])); assert.deepEqual(after.pages[0].bounds, info.pages[0].bounds); assert.equal(after.pages[0].sourceRotate, info.pages[0].sourceRotate);
          const lines = (await reopened.text(0)).lines.filter(line => line.text !== 'Outside neighbor 123');
          const rows = visualRows(lines);
          if (value === 'Short') assert.equal(rows.length, 1); else assert.ok(rows.length > 2, 'Longer text reflows beyond the original two rows');
          assert.ok(lines.every(line => line.content.runs.every(run => run.style.sizePt === 12)), 'Wrapping never shrinks source font');
        } finally { reopened.close(); }
      }
      assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    } finally { api.close(); }
  });
}

for (const unsafe of ['neighbor', 'clip'] as const) {
  test(`grouped replacement rejects ${unsafe} overflow and leaves source intact`, async () => {
    const bytes = fixture({ clip: unsafe === 'clip' }); const api = createNativePdfApi(loadFont, () => {});
    try {
      await api.open(new Blob([Uint8Array.from(bytes)])); const source = await api.text(0); const group = buildSourceTextGroup(pdfPage(0), source, selected(source));
      const content = replacement(group.content, Array(unsafe === 'clip' ? 5 : 14).fill('Alpha beta gamma delta').join('\n'));
      const page = { ...pdfPage(0), textEdits: [{ ...editFrom(group), content }] };
      assert.equal((await api.validate(page)).ok, false); await assert.rejects(api.export(workspace(bytes, [page])));
      assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    } finally { api.close(); }
  });
}

test('group apply is atomic, undo restores independent edits, and duplicate group edits remain independent', () => {
  const page = pdfPage(0); const singles = ['a', 'b', 'outside'].map(id => ({ lineIds: [id], content: textContent(id), widthPt: 150 })); page.textEdits = singles;
  let state = documentReducer(initialDocumentState, { type: 'LOAD_DOCUMENT', workspace: workspace(new Uint8Array([1, 2]), [page]) });
  const edit: SourceTextEdit = { lineIds: ['a', 'b'], content: textContent('joined'), widthPt: 150, layout: { lineHeightPt: 18, referenceSizePt: 16, firstLineIndentPt: 0, restLineIndentPt: 0 } };
  state = documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: page.id, edit });
  const edits = () => (state.workspace!.pages[0] as PdfPage).textEdits;
  assert.deepEqual(edits().find(e => e.lineIds.includes('a')), edit); assert.deepEqual(edits().find(e => e.lineIds.includes('outside')), singles[2]); assert.equal(edits().length, 2);
  assert.equal(state.history.undo.length, 1);
  assert.equal(documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: page.id, edit }), state);
  const grouped = state;
  state = documentReducer(state, { type: 'UNDO' }); assert.deepEqual(edits(), singles);
  state = documentReducer(state, { type: 'REDO' }); assert.deepEqual(edits(), (grouped.workspace!.pages[0] as PdfPage).textEdits);
  state = documentReducer(state, { type: 'DUPLICATE_PAGE', id: page.id, newId: 'copy' });
  state = documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: 'copy', edit: { ...edit, content: textContent('copy only') } });
  assert.deepEqual(edits(), (grouped.workspace!.pages[0] as PdfPage).textEdits);
  assert.equal((state.workspace!.pages[1] as PdfPage).textEdits.find(e => e.lineIds.includes('a'))!.content.runs[0].text, 'copy only');
  state = documentReducer(state, { type: 'REMOVE_TEXT_EDIT', pageId: 'copy', lineId: 'b' });
  assert.deepEqual((state.workspace!.pages[1] as PdfPage).textEdits, [singles[2]]);
});

test('v2 normalization preserves source Blob, edits and page order without mutating input', async () => {
  const page = { ...pdfPage(0), images: [], signatureFields: [], textBoxes: [], shapes: [] };
  const source = workspace(new Uint8Array([1, 2, 3]), [page, { ...pdfPage(1), images: [], signatureFields: [], textBoxes: [] } as PdfPage]);
  const content = textContent('saved edit');
  const legacyContent = { ...content, runs: content.runs.map(run => ({ ...run, style: { ...run.style, highlight: null } })) };
  const legacyEdits = [{ lineId: 'a', content: legacyContent, widthPt: 140 }];
  const legacy = { version: 2, zoom: 1.25, revision: 7, savedAt: 123, workspace: { ...source, activePageId: 'page-1', pages: [{ ...page, textEdits: legacyEdits }, source.pages[1]] } };
  const migrated = normalizePdfDraft(legacy); assert.equal(migrated.version, 5); assert.equal(migrated.workspace.source, source.source); assert.deepEqual(new Uint8Array(await migrated.workspace.source.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal('shapes' in migrated.workspace.pages[0], false);
  assert.equal(migrated.workspace.fileName, source.fileName); assert.equal(migrated.workspace.sourceHash, source.sourceHash); assert.equal(migrated.workspace.activePageId, 'page-1'); assert.deepEqual(migrated.workspace.pages.map(p => p.id), ['page-0', 'page-1']);
  assert.equal(migrated.zoom, 1.25); assert.equal(migrated.revision, 7); assert.equal(migrated.savedAt, 123);
  assert.deepEqual((migrated.workspace.pages[0] as PdfPage).textEdits, [{ lineIds: ['a'], content: textContent('saved edit'), widthPt: 140 }]);
  assert.equal(legacyEdits[0].lineId, 'a'); assert.equal(legacyContent.runs[0].style.highlight, null); assert.equal(legacy.version, 2);
  assert.throws(() => normalizePdfDraft({ ...legacy, workspace: { ...legacy.workspace, activePageId: 'missing' } }));
});

test('v5 normalization roundtrips group layout and rejects invalid layout or overlapping ownership', () => {
  const layout = { lineHeightPt: 18, referenceSizePt: 12, firstLineIndentPt: 5, restLineIndentPt: 0 };
  const edit: SourceTextEdit = { lineIds: ['a', 'b'], content: textContent('saved\nhard break'), widthPt: 140, layout };
  const draft = (textEdits: unknown[]) => ({ version: 5, zoom: 1, revision: 1, savedAt: 123, workspace: workspace(new Uint8Array([1]), [{ ...pdfPage(0), textEdits } as PdfPage]) });
  assert.deepEqual((normalizePdfDraft(draft([edit])).workspace.pages[0] as PdfPage).textEdits, [edit]);
  const legacyContent = { ...edit.content, runs: edit.content.runs.map(run => ({ ...run, style: { ...run.style, highlight: null } })) };
  const legacy = { ...draft([edit]), version: 3, workspace: workspace(new Uint8Array([1]), [{ ...pdfPage(0), images: [], signatureFields: [], textBoxes: [], textEdits: [{ ...edit, content: legacyContent }] } as PdfPage]) };
  const migrated = normalizePdfDraft(legacy);
  assert.equal(migrated.version, 5);
  assert.deepEqual((migrated.workspace.pages[0] as PdfPage).textEdits, [edit]);
  const invalid = [
    { ...edit, layout: undefined }, { ...edit, lineIds: [] }, { ...edit, lineIds: ['a', 'a'] },
    { ...edit, layout: { ...layout, lineHeightPt: 0 } }, { ...edit, layout: { ...layout, referenceSizePt: NaN } },
    { ...edit, layout: { ...layout, firstLineIndentPt: -1 } }, { ...edit, layout: { ...layout, restLineIndentPt: 140 } },
    { ...edit, lineIds: ['a'] },
  ];
  for (const value of invalid) assert.throws(() => normalizePdfDraft(draft([value])));
  assert.throws(() => normalizePdfDraft(draft([edit, { lineIds: ['b'], widthPt: 140, content: textContent('overlap') }])));
});

test('partial group ownership and duplicate member IDs are rejected without history changes', () => {
  const edit: SourceTextEdit = { lineIds: ['a', 'b'], content: textContent('joined'), widthPt: 150, layout: { lineHeightPt: 18, referenceSizePt: 16, firstLineIndentPt: 0, restLineIndentPt: 0 } };
  const page = { ...pdfPage(0), textEdits: [edit] };
  const state = documentReducer(initialDocumentState, { type: 'LOAD_DOCUMENT', workspace: workspace(new Uint8Array([1]), [page]) });
  for (const lineIds of [['a'], ['b', 'c'], ['a', 'a'], []]) {
    assert.equal(documentReducer(state, { type: 'UPSERT_TEXT_EDIT', pageId: page.id, edit: { ...edit, lineIds } }), state);
  }
});

test('one numbered item and its continuation preserve hanging indent, while separate numbered items cannot merge', async () => {
  for (const list of ['continuation', 'separate'] as const) {
    const bytes = fixture({ list }); const api = createNativePdfApi(loadFont, () => {});
    try {
      await api.open(new Blob([Uint8Array.from(bytes)])); const source = await api.text(0);
      const members = source.lines.filter(line => line.text !== 'Outside neighbor 123');
      assert.equal(members.length, 2);
      if (list === 'separate') {
        assert.throws(() => buildSourceTextGroup(pdfPage(0), source, members.map(line => line.lineId)));
      } else {
        const group = buildSourceTextGroup(pdfPage(0), source, members.map(line => line.lineId).reverse());
        assert.equal(group.content.runs.map(run => run.text).join(''), '1. Alpha beta gamma delta Epsilon zeta eta theta');
        assert.deepEqual(group.layout, { lineHeightPt: 18, referenceSizePt: 12, firstLineIndentPt: 0, restLineIndentPt: 12 });
        assert.deepEqual(group.content.runs[0].style.font, members[0].content.runs[0].style.font);
        const page = { ...pdfPage(0), textEdits: [editFrom(group)] };
        assert.deepEqual(await api.validate(page), { ok: true });
        const out = await api.export(workspace(bytes, [page]));
        const reopened = createNativePdfApi(loadFont, () => {});
        try {
          await reopened.open(new Blob([Uint8Array.from(out)]));
          const lines = (await reopened.text(0)).lines.filter(line => line.text !== 'Outside neighbor 123');
          const rows = visualRows(lines);
          assert.equal(rows.map(row => row.text).join(''), '1. Alpha beta gamma delta Epsilon zeta eta theta');
          assert.ok(rows.length > 1, 'The item reflows onto hanging-indent continuation rows');
          for (let i = 1; i < rows.length; i++) assert.equal(rows[i].baseline - rows[i - 1].baseline, 18);
          const starts = rows.map(row => Math.min(...lines.flatMap(line => line.chars).filter(char => Math.abs(char.origin[1] - row.baseline) < 0.01).map(char => char.origin[0])));
          assert.deepEqual(starts, rows.map((_, i) => i === 0 ? 40 : 52));
        } finally { reopened.close(); }
      }
      assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    } finally { api.close(); }
  }
});

test('reopened and persisted groups retain custom width, current bundled font and layout', async () => {
  const bytes = fixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)])); const source = await api.text(0);
    const group = buildSourceTextGroup(pdfPage(0), source, selected(source));
    const font = { kind: 'bundled', family: 'Courier', bold: true } as const;
    const edit: SourceTextEdit = {
      ...editFrom(group), widthPt: 210,
      layout: { ...group.layout, firstLineIndentPt: 4, restLineIndentPt: 10 },
      content: { align: 'left', runs: [{ text: 'Custom width and font\nRetained after reopen', style: { ...group.content.runs[0].style, font } }] },
    };
    const page = { ...pdfPage(0), textEdits: [edit] };
    assert.deepEqual(await api.validate(page), { ok: true });
    const draft = normalizePdfDraft({ version: 4, zoom: 1, revision: 2, savedAt: 123, workspace: workspace(bytes, [page]) });
    const restored = draft.workspace.pages[0] as PdfPage;
    assert.deepEqual(restored.textEdits, [edit]);
    const rendered = await api.render(restored, 1);
    const target = rendered.textTargets.find(target => target.kind === 'source' && target.lineIds.includes(group.lineIds[0]));
    assert.ok(target); assert.equal(target.kind, 'source');
    if (target.kind !== 'source') assert.fail('Expected group target');
    assert.equal(target.widthPt, 210); assert.deepEqual(target.layout, edit.layout);
    assert.deepEqual(target.content.runs[0].style.font, font); assert.deepEqual(target.content, edit.content);
    const out = await api.export(draft.workspace);
    assert.ok(extractedText(out).replace(/\s+/g, ' ').includes('Custom width and font Retained after reopen'));
  } finally { api.close(); }
});

test('a carried word wider than the hanging-indent continuation width rewraps without losing glyphs', async () => {
  const bytes = fixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)])); const source = await api.text(0);
    const group = buildSourceTextGroup(pdfPage(0), source, selected(source));
    const content: TextContent = {
      align: 'left', runs: [{ text: 'A WWWWWWWWWWWW', style: { ...group.content.runs[0].style, font: { kind: 'bundled', family: 'Courier', bold: false }, sizePt: 12 } }],
    };
    const page = { ...pdfPage(0), textEdits: [{
      ...editFrom(group), content, widthPt: 100,
      layout: { ...group.layout, firstLineIndentPt: 0, restLineIndentPt: 30 },
    }] };
    assert.deepEqual(await api.validate(page), { ok: true });
    const out = await api.export(workspace(bytes, [page]));
    const reopened = createNativePdfApi(loadFont, () => {});
    try {
      await reopened.open(new Blob([Uint8Array.from(out)]));
      const lines = (await reopened.text(0)).lines.filter(line => line.text !== 'Outside neighbor 123');
      const rows = visualRows(lines);
      assert.equal(rows.map(row => row.text).join('').replace(/\s/g, ''), 'AWWWWWWWWWWWW');
      assert.equal(rows.length, 3, 'The twelve-letter word requires two 70pt continuation rows');
      const chars = lines.flatMap(line => line.chars);
      for (const [index, row] of rows.entries()) {
        const glyphs = chars.filter(char => Math.abs(char.origin[1] - row.baseline) < 0.01);
        const left = index === 0 ? 40 : 70;
        assert.ok(glyphs.every(char => char.sizePt === 12));
        assert.ok(glyphs.every(char => char.origin[0] >= left - 0.01 && char.origin[0] + 7.2 <= 140.01), 'Courier 12pt advances must stay within the 100pt first / 70pt continuation width');
      }
    } finally { reopened.close(); }
  } finally { api.close(); }
});

test('extending an existing same-row group through a touching source span does not invent a space', async () => {
  const pdf = new mupdf.PDFDocument(); const font = new mupdf.Font('Helvetica');
  let bytes: Uint8Array;
  try {
    pdf.insertPage(-1, pdf.addPage([0, 0, 420, 420], 0, { Font: { F0: pdf.addSimpleFont(font) } },
      'BT /F0 12 Tf 1 0 0 1 40 350 Tm 0 0 0 rg (HHHH) Tj 1 0 0 rg (HHHH) Tj 0 0 1 rg (HHHH) Tj ET'));
    bytes = saved(pdf);
  } finally { font.destroy(); pdf.destroy(); }
  const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)])); const source = await api.text(0);
    const members = [...source.lines].sort((a, b) => a.origin[0] - b.origin[0]); assert.equal(members.length, 3);
    const first = buildSourceTextGroup(pdfPage(0), source, members.slice(0, 2).map(line => line.lineId));
    const page = { ...pdfPage(0), textEdits: [editFrom(first)] };
    const extended = buildSourceTextGroup(page, source, members.map(line => line.lineId).reverse());
    assert.equal(extended.content.runs.map(run => run.text).join(''), 'HHHHHHHHHHHH');
    assert.deepEqual(extended.content.runs.map(run => run.style.color), [[0, 0, 0], [1, 0, 0], [0, 0, 1]]);
    const out = await api.export(workspace(bytes, [{ ...page, textEdits: [editFrom(extended)] }]));
    assert.equal(extractedText(out).trim(), 'HHHHHHHHHHHH');
  } finally { api.close(); }
});

for (const divider of ['vertical', 'horizontal'] as const) {
  test(`native ${divider} table ruling rejects otherwise adjacent source spans`, async () => {
    const pdf = new mupdf.PDFDocument(); const font = new mupdf.Font('Helvetica');
    let bytes: Uint8Array;
    try {
      const second = divider === 'vertical' ? '80 350' : '40 332';
      const rule = divider === 'vertical' ? '77 340 m 77 365 l' : '35 346 m 100 346 l';
      pdf.insertPage(-1, pdf.addPage([0, 0, 420, 420], 0, { Font: { F0: pdf.addSimpleFont(font) } },
        `BT /F0 12 Tf 1 0 0 1 40 350 Tm (HHHH) Tj ET\nBT /F0 12 Tf 1 0 0 1 ${second} Tm (HHHH) Tj ET\n0 G 0.5 w ${rule} S`));
      bytes = saved(pdf);
    } finally { font.destroy(); pdf.destroy(); }
    const api = createNativePdfApi(loadFont, () => {});
    try {
      await api.open(new Blob([Uint8Array.from(bytes)])); const source = await api.text(0);
      assert.equal(source.lines.length, 2); assert.ok(source.lines.every(line => line.editable));
      assert.throws(() => buildSourceTextGroup(pdfPage(0), source, source.lines.map(line => line.lineId)));
      assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    } finally { api.close(); }
  });
}


import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createNativePdfApi } from '../src/pdf/nativeDocument';
import type { NativePdfApi, SourceTextLine } from '../src/pdf/engineTypes';
import type { PdfPage, Rect } from '../src/types/pdfEditor';
import { adjacentColorSpanFixture, annotations, bundledFont, denseParagraphFixture, directRender, extractedText, fidelityFixture, LITERAL, loadFont, mupdf, ORIGINAL, pdfPage, REPLACEMENT, textContent, titleBodyFixture, unsafeFixture, workspace } from './fixtures';
import type { DirectRaster } from './fixtures';

async function sourceLine(api: NativePdfApi, text: string): Promise<SourceTextLine> {
  const lines = (await api.text(0)).lines;
  const found = lines.find(line => line.text === text);
  assert.ok(found, `Missing source line ${JSON.stringify(text)}; got ${lines.map(line => JSON.stringify(line.text)).join(', ')}`);
  return found;
}

function edit(page: PdfPage, line: SourceTextLine, value: string): PdfPage {
  return { ...page, textEdits: [{ lineIds: [line.lineId], content: textContent(value), widthPt: 220 }] };
}

function unchangedOutside(before: DirectRaster, after: DirectRaster, excluded: Rect): void {
  assert.equal(after.width, before.width); assert.equal(after.height, before.height);
  for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) {
    if (x >= excluded[0] && x <= excluded[2] && y >= excluded[1] && y <= excluded[3]) continue;
    const offset = (y * before.width + x) * 4;
    for (let channel = 0; channel < 4; channel++) {
      if (after.rgba[offset + channel] !== before.rgba[offset + channel]) assert.fail(`Unselected pixel changed at ${x},${y}, channel ${channel}`);
    }
  }
}

for (const fixture of ['existing test.pdf', 'color/photo/vector/Korean'] as const) {
  test(`untouched ${fixture}: direct source RGBA and exact original download bytes`, async () => {
    const bytes = fixture === 'existing test.pdf' ? new Uint8Array(await readFile(new URL('../test.pdf', import.meta.url))) : await fidelityFixture();
    const api = createNativePdfApi(loadFont, () => {});
    try {
      const info = await api.open(new Blob([Uint8Array.from(bytes)]));
      const pages = info.pages.map((_, index) => pdfPage(index));
      for (let index = 0; index < pages.length; index++) {
        const baseline = directRender(bytes, index, 1.5);
        const rendered = await api.render(pages[index], 1.5);
        assert.equal(rendered.width, baseline.width); assert.equal(rendered.height, baseline.height);
        assert.deepEqual(rendered.rgba, baseline.rgba);
        // Merely asking for selectable text must not mutate the native document.
        await api.text(index);
      }
      assert.deepEqual(await api.export({ ...workspace(bytes, pages), fileName: 'renamed.pdf' }), bytes);
    } finally { api.close(); }
  });
}

test('Korean number replacement is searchable native text and preserves photo, grid, background and unrelated glyphs', async () => {
  const bytes = await fidelityFixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const original = await sourceLine(api, ORIGINAL); assert.equal(original.editable, true, original.reason);
    const page = edit(pdfPage(0), original, REPLACEMENT);
    assert.deepEqual(await api.validate(page), { ok: true });
    const out = await api.export(workspace(bytes, [page]));
    const text = extractedText(out);
    assert.ok(text.includes(REPLACEMENT), text); assert.ok(!text.includes(ORIGINAL), text);
    assert.ok(text.includes('Untouched Latin 12345')); assert.ok(text.includes('독립적인 한글 문장'));
    unchangedOutside(directRender(bytes), directRender(out), [38, 65, 262, 112]);
    const preview = await api.render(page, 1); assert.deepEqual(preview.rgba, directRender(out).rgba);
    const font = new mupdf.Font('ProbeNanum', await loadFont(bundledFont));
    try {
      const spaceStart = 40 + [...'계약금'].reduce((width, char) => width + font.advanceGlyph(font.encodeCharacter(char.codePointAt(0)!)) * 16, 0);
      const spaceEnd = spaceStart + font.advanceGlyph(font.encodeCharacter(32)) * 16;
      const before = directRender(bytes); const after = directRender(out);
      let probes = 0;
      for (let x = Math.ceil(spaceStart + 1); x < Math.floor(spaceEnd - 1); x++) for (let y = 74; y < 92; y++) {
        const offset = (y * before.width + x) * 4;
        assert.deepEqual(after.rgba.slice(offset, offset + 4), before.rgba.slice(offset, offset + 4), `Original colored space/grid changed at ${x},${y}`); probes++;
      }
      assert.ok(probes > 0, 'Fixture must sample actual inter-word background');
    } finally { font.destroy(); }
    const pdf = new mupdf.PDFDocument(out); const nativePage = pdf.loadPage(0);
    const structured = nativePage.toStructuredText('vectors,preserve-images');
    try {
      let vectors = 0; let images = 0;
      structured.walk({ onVector() { vectors++; }, onImageBlock() { images++; } });
      assert.ok(vectors > 20, 'Vector grid must remain vector content'); assert.equal(images, 1, 'Original small photograph remains, not a full-page raster replacement');
      assert.ok(nativePage.search(REPLACEMENT, {}).length > 0);
    } finally { structured.destroy(); nativePage.destroy(); pdf.destroy(); }
    assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes, 'Candidate/export must not mutate source');
  } finally { api.close(); }
});

for (const family of ['Helvetica', 'NanumGothic'] as const) {
  test(`dense 12pt ${family} paragraph: number and color edits preserve neighboring 18pt-leading lines`, async () => {
    const bytes = await denseParagraphFixture(family); const api = createNativePdfApi(loadFont, () => {});
    const originalText = family === 'Helvetica' ? 'Payment amount 30,000 won' : ORIGINAL;
    const replacement = originalText.replace('30,000', '45,000');
    const neighbors = family === 'Helvetica' ? ['Previous paragraph line 100', 'Following paragraph line 200'] : ['이전 문단의 내용 100', '다음 문단의 내용 200'];
    try {
      await api.open(new Blob([Uint8Array.from(bytes)]));
      const original = await sourceLine(api, originalText); assert.equal(original.editable, true, original.reason);
      const page: PdfPage = { ...pdfPage(0), textEdits: [{
        lineIds: [original.lineId], widthPt: original.widthPt,
        content: { ...original.content, runs: original.content.runs.map(run => ({ ...run, text: run.text.replace('30,000', '45,000') })) },
      }] };
      assert.deepEqual(await api.validate(page), { ok: true });
      const out = await api.export(workspace(bytes, [page]));
      assert.ok(extractedText(out).includes(replacement)); assert.ok(!extractedText(out).includes(originalText));
      for (const neighbor of neighbors) assert.ok(extractedText(out).includes(neighbor), neighbor);
      unchangedOutside(directRender(bytes), directRender(out), [38, 94, 260, 113]);

      page.textEdits[0].content = { ...original.content, runs: original.content.runs.map(run => ({
        ...run, style: { ...run.style, color: [0, 0, 1] },
      })) };
      assert.deepEqual(await api.validate(page), { ok: true });
      const colored = await api.export(workspace(bytes, [page]));
      assert.ok(extractedText(colored).includes(originalText));
      for (const neighbor of neighbors) assert.ok(extractedText(colored).includes(neighbor), neighbor);
      unchangedOutside(directRender(bytes), directRender(colored), [38, 94, 260, 113]);
      assert.notDeepEqual(directRender(colored).rgba, directRender(bytes).rgba, 'Color-only edit must change the selected text');
      const reopened = createNativePdfApi(loadFont, () => {});
      try {
        await reopened.open(new Blob([Uint8Array.from(colored)]));
        const selected = (await reopened.text(0)).lines.flatMap(line => line.chars)
          .filter(char => Math.abs(char.origin[1] - original.origin[1]) < 0.01)
          .sort((a, b) => a.origin[0] - b.origin[0]);
        assert.equal(selected.map(char => char.text).join(''), originalText);
        for (const char of selected) assert.deepEqual(char.color, [0, 0, 1]);
      } finally { reopened.close(); }
      assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    } finally { api.close(); }
  });
}

for (const kind of ['tj', 'clip', 'Helvetica14', 'Nanum12', 'Nanum14'] as const) {
  test(`${kind}: isolated title and ordinary body are editable while native edits preserve neighbors`, async () => {
    const bytes = await titleBodyFixture(kind); const api = createNativePdfApi(loadFont, () => {});
    const dense = kind !== 'tj' && kind !== 'clip';
    const korean = kind.startsWith('Nanum');
    const originalText = dense ? korean ? ORIGINAL : 'Payment amount 30,000 won' : 'Body text sample';
    const replacement = dense ? originalText.replace('30,000', '45,000') : originalText.replace('text', 'test');
    const neighbors = ['Document title', ...(dense
      ? korean ? ['이전 문단의 내용 100', '다음 문단의 내용 200'] : ['Previous paragraph line 100', 'Following paragraph line 200']
      : ['Untouched neighbor 200'])];
    try {
      await api.open(new Blob([Uint8Array.from(bytes)]));
      const title = await sourceLine(api, 'Document title'); assert.equal(title.editable, true, title.reason);
      const original = await sourceLine(api, kind === 'tj' ? 'Bodytextsample' : originalText); assert.equal(original.editable, true, original.reason);
      assert.equal(original.content.runs.map(run => run.text).join(''), originalText);
      assert.ok((await api.copySourceText(0, [0, 0], [420, 420])).includes(originalText), 'Semantic copy must retain body word spaces');
      const before = directRender(bytes);
      // Tight glyph paint bounds avoid font-metric overlap without assuming a
      // blank raster row between tightly led Korean lines.
      const paint = original.chars.map(char => { assert.ok(char.paintBounds); return char.paintBounds; });
      const excluded: Rect = [
        Math.floor(Math.min(...paint.map(bounds => bounds[0]))),
        Math.floor(Math.min(...paint.map(bounds => bounds[1]))),
        Math.ceil(Math.max(...paint.map(bounds => bounds[2]))),
        Math.ceil(Math.max(...paint.map(bounds => bounds[3]))),
      ];
      const neighborLines = await Promise.all(neighbors.map(text => sourceLine(api, text)));
      for (const colorOnly of [false, true]) {
        const page: PdfPage = { ...pdfPage(0), textEdits: [{
          lineIds: [original.lineId], widthPt: original.widthPt,
          content: { ...original.content, runs: original.content.runs.map(run => ({
            ...run, text: colorOnly ? run.text : dense ? run.text.replace('30,000', '45,000') : run.text.replace('text', 'test'),
            style: colorOnly ? { ...run.style, color: [0, 0, 1] } : run.style,
          })) },
        }] };
        assert.deepEqual(await api.validate(page), { ok: true });
        const out = await api.export(workspace(bytes, [page]));
        const text = extractedText(out).replace(/\s/g, '');
        assert.ok(text.includes((colorOnly ? originalText : replacement).replace(/\s/g, '')), text);
        if (!colorOnly) assert.ok(!text.includes(originalText.replace(/\s/g, '')), 'Original body must be removed');
        for (const neighbor of neighbors) assert.ok(text.includes(neighbor.replace(/\s/g, '')), neighbor);
        const after = directRender(out);
        unchangedOutside(before, after, excluded);
        assert.notDeepEqual(after.rgba, before.rgba, 'Selected body edit must be visible');
        const reopened = createNativePdfApi(loadFont, () => {});
        try {
          await reopened.open(new Blob([Uint8Array.from(out)]));
          const reopenedChars = (await reopened.text(0)).lines.flatMap(line => line.chars);
          for (const neighbor of neighborLines) {
            const preserved = reopenedChars.filter(char => Math.abs(char.origin[1] - neighbor.origin[1]) < 0.01)
              .sort((a, b) => a.origin[0] - b.origin[0]);
            assert.deepEqual(preserved.map(char => ({ text: char.text, origin: char.origin, color: char.color, sizePt: char.sizePt })),
              neighbor.chars.map(char => ({ text: char.text, origin: char.origin, color: char.color, sizePt: char.sizePt })));
          }
          const selected = reopenedChars
            .filter(char => Math.abs(char.origin[1] - original.origin[1]) < 0.01)
            .sort((a, b) => a.origin[0] - b.origin[0]);
          assert.equal(selected.map(char => char.text).join('').replace(/\s/g, ''), (colorOnly ? originalText : replacement).replace(/\s/g, ''));
          if (colorOnly) for (const char of selected) assert.deepEqual(char.color, [0, 0, 1]);
        } finally { reopened.close(); }
      }
      assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    } finally { api.close(); }
  });
}

test('paragraph clipping that actually cuts a body glyph remains non-editable', async () => {
  const bytes = await titleBodyFixture('cut'); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    assert.equal((await sourceLine(api, 'Document title')).editable, true);
    const body = await sourceLine(api, 'Body text sample');
    assert.equal(body.editable, false); assert.ok(body.reason);
    const page: PdfPage = { ...pdfPage(0), textEdits: [{
      lineIds: [body.lineId], widthPt: body.widthPt,
      content: { ...body.content, runs: body.content.runs.map(run => ({ ...run, text: run.text.replace('text', 'test') })) },
    }] };
    assert.equal((await api.validate(page)).ok, false);
    await assert.rejects(api.export(workspace(bytes, [page])));
    assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    assert.deepEqual((await api.render(pdfPage(0), 1)).rgba, directRender(bytes).rgba);
  } finally { api.close(); }
});

test('contained paragraph clip rejects an edit that expands beyond its original clip', async () => {
  const bytes = await titleBodyFixture('clip'); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const body = await sourceLine(api, 'Body text sample'); assert.equal(body.editable, true, body.reason);
    const page: PdfPage = { ...pdfPage(0), textEdits: [{
      lineIds: [body.lineId], widthPt: body.widthPt,
      content: { ...body.content, runs: body.content.runs.map(run => ({ ...run, text: `${run.text}\n`.repeat(6) })) },
    }] };
    const validation = await api.validate(page);
    assert.equal(validation.ok, false);
    if (validation.ok) assert.fail('Replacement must stay within the original paragraph clip');
    assert.equal(validation.code, 'CLIPPED_TEXT');
    await assert.rejects(api.export(workspace(bytes, [page])));
    assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    assert.deepEqual((await api.render(pdfPage(0), 1)).rgba, directRender(bytes).rgba);
  } finally { api.close(); }
});

test('adjacent color spans: same-advance replacement preserves the contiguous red span', async () => {
  const bytes = adjacentColorSpanFixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const spans = (await api.text(0)).lines;
    const black = spans.find(line => line.text === 'HHHH' && line.content.runs[0].style.color.every(value => value === 0));
    const red = spans.find(line => line.text === 'HHHH' && line.content.runs[0].style.color[0] === 1);
    assert.ok(black); assert.ok(red); assert.equal(black.editable, true, black.reason);
    const page: PdfPage = { ...pdfPage(0), textEdits: [{
      lineIds: [black.lineId], widthPt: black.widthPt,
      content: { ...black.content, runs: black.content.runs.map(run => ({ ...run, text: 'NNNN' })) },
    }] };
    assert.deepEqual(await api.validate(page), { ok: true });
    const out = await api.export(workspace(bytes, [page]));
    const text = extractedText(out).replace(/\s/g, '');
    assert.ok(text.includes('NNNN'), text); assert.equal(text.match(/H/g)?.length, 4, 'Only the unchanged red H glyphs remain');
    // Helvetica H and N both advance 8.664pt at 12pt. Red starts at x=74.656;
    // its pixels are outside this independently specified replacement region.
    unchangedOutside(directRender(bytes), directRender(out), [39, 76, 74, 94]);
    const reopened = createNativePdfApi(loadFont, () => {});
    try {
      await reopened.open(new Blob([Uint8Array.from(out)]));
      const unchanged = await sourceLine(reopened, 'HHHH');
      assert.deepEqual(unchanged.content, red.content); assert.deepEqual(unchanged.origin, red.origin);
    } finally { reopened.close(); }
  } finally { api.close(); }
});

test('dense paragraph: an explicit newline overlapping the following line is rejected without mutation', async () => {
  const bytes = await denseParagraphFixture('Helvetica'); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const original = await sourceLine(api, 'Payment amount 30,000 won');
    const page: PdfPage = { ...pdfPage(0), textEdits: [{
      lineIds: [original.lineId], widthPt: original.widthPt,
      content: { ...original.content, runs: original.content.runs.map(run => ({ ...run, text: `${run.text}\nFollowing` })) },
    }] };
    const validation = await api.validate(page);
    assert.equal(validation.ok, false);
    if (validation.ok) assert.fail('A new line must not cover neighboring source text');
    assert.equal(validation.code, 'TEXT_OVERLAP');
    await assert.rejects(api.export(workspace(bytes, [page])));
    assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    assert.deepEqual((await api.render(pdfPage(0), 1)).rgba, directRender(bytes).rgba);
  } finally { api.close(); }
});

test('subset source font requires consent, then Korean bold/size/color survive save and reopen', async () => {
  const bytes = await fidelityFixture({ subset: true }); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const original = await sourceLine(api, ORIGINAL);
    const replacement = '추가금 45,000원';
    const page: PdfPage = { ...pdfPage(0), textEdits: [{ lineIds: [original.lineId], widthPt: 240, content: { ...original.content, runs: original.content.runs.map((run, index) => ({ ...run, text: index === 0 ? replacement : '' })) } }] };
    const validation = await api.validate(page);
    assert.equal(validation.ok, false);
    if (validation.ok) assert.fail('Missing glyph must not be silently substituted');
    assert.equal(validation.code, 'FONT_SUBSTITUTION_REQUIRED'); assert.equal(validation.proposedFont?.kind, 'bundled');
    assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    page.textEdits[0].content = textContent(replacement, { bold: true, sizePt: 18, color: [0.8, 0.1, 0.2] });
    assert.deepEqual(await api.validate(page), { ok: true });
    const out = await api.export(workspace(bytes, [page]));
    assert.ok(extractedText(out).includes(replacement));
    const pdf = new mupdf.PDFDocument(out); const nativePage = pdf.loadPage(0); const text = nativePage.toStructuredText('');
    try {
      let found = false;
      text.walk({ onChar(char, origin, font, size, _quad, color) {
        try {
          if (char === '추' && origin[1] < 130) {
            found = true; assert.equal(font.isBold(), true); assert.ok(Math.abs(size - 18) < 0.01);
            assert.equal(color.length, 3); color.forEach((value, index) => assert.ok(Math.abs(value - [0.8, 0.1, 0.2][index]) < 0.01));
          }
        } finally { font.destroy(); }
      } });
      assert.equal(found, true);
    } finally { text.destroy(); nativePage.destroy(); pdf.destroy(); }
  } finally { api.close(); }
});

test('HTML-like source and replacement strings remain literal searchable PDF text', async () => {
  const bytes = await fidelityFixture({ literal: true }); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    assert.equal((await sourceLine(api, LITERAL)).text, LITERAL);
    const page = pdfPage(0);
    const original = await sourceLine(api, ORIGINAL);
    page.textEdits.push({ lineIds: [original.lineId], widthPt: 350, content: textContent(LITERAL, { sizePt: 10 }) });
    assert.deepEqual(await api.validate(page), { ok: true });
    const text = extractedText(await api.export(workspace(bytes, [page])));
    assert.equal(text.split(LITERAL).length - 1, 2);
  } finally { api.close(); }
});

for (const kind of ['overlap', 'ligature', 'nonBMP', 'actualText', 'clipped', 'vertical'] as const) {
  test(`${kind}: restrict unsafe target only, preserve viewing/copy and allow unrelated Korean editing`, async () => {
    const bytes = await unsafeFixture(kind); const api = createNativePdfApi(loadFont, () => {});
    try {
      await api.open(new Blob([Uint8Array.from(bytes)]));
      assert.deepEqual((await api.render(pdfPage(0), 1)).rgba, directRender(bytes).rgba);
      const lines = (await api.text(0)).lines;
      const safe = lines.find(line => line.text === '정상 한글 Safe 123'); assert.ok(safe); assert.equal(safe.editable, true, safe.reason);
      const unsafe = lines.filter(line => line.lineId !== safe.lineId);
      assert.ok(unsafe.length > 0, 'Unsafe source target must be identified with a reason');
      for (const target of unsafe) {
        assert.equal(target.editable, false, `${kind} target unexpectedly editable`); assert.ok(target.reason);
        const bad = edit(pdfPage(0), target, 'Unsafe replacement');
        assert.equal((await api.validate(bad)).ok, false);
        await assert.rejects(api.export(workspace(bytes, [bad])));
      }
      const semantic = await api.copySourceText(0, [0, 0], [420, 420]);
      if (kind === 'nonBMP') assert.ok(semantic.includes('😀'), semantic);
      if (kind === 'actualText') assert.ok(semantic.includes('실제 의미 😀'), semantic);
      if (kind === 'ligature') assert.ok(semantic.includes('fi'), semantic);
      assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
      const good = edit(pdfPage(0), safe, '정상 한글 Safe 456');
      assert.deepEqual(await api.validate(good), { ok: true });
      const out = await api.export(workspace(bytes, [good]));
      assert.ok(extractedText(out).includes('정상 한글 Safe 456'));
      if (kind === 'nonBMP') assert.ok(extractedText(out).includes('😀'));
      unchangedOutside(directRender(bytes), directRender(out), [38, 210, 262, 246]);
    } finally { api.close(); }
  });
}

test('overflow and overlap with an unselected line are rejected without modifying original bytes', async () => {
  const bytes = await fidelityFixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)])); const line = await sourceLine(api, ORIGINAL);
    const page = edit(pdfPage(0), line, `${REPLACEMENT}\n`.repeat(40)); page.textEdits[0].widthPt = 220;
    assert.equal((await api.validate(page)).ok, false); await assert.rejects(api.export(workspace(bytes, [page])));
    const collision = edit(pdfPage(0), line, Array.from({ length: 8 }, () => REPLACEMENT).join('\n'));
    assert.equal((await api.validate(collision)).ok, false);
    assert.deepEqual(await api.export(workspace(bytes, [pdfPage(0)])), bytes);
    assert.deepEqual((await api.render(pdfPage(0), 1)).rgba, directRender(bytes).rgba);
  } finally { api.close(); }
});

test('body edit preserves overlapping Link, FreeText/Popup/IRT and preexisting Redact annotations', async () => {
  const bytes = await fidelityFixture({ annotations: true }); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const body = await sourceLine(api, ORIGINAL);
    assert.equal((await api.text(0)).lines.some(line => line.text === 'Kept annotation'), false, 'Annotation text must not become body edit targets');
    const page = edit(pdfPage(0), body, REPLACEMENT); assert.deepEqual(await api.validate(page), { ok: true });
    const out = await api.export(workspace(bytes, [page]));
    const pdf = new mupdf.PDFDocument(out);
    try {
      const annots = annotations(pdf, 0);
      assert.deepEqual([...annots.keys()], ['original-link', 'original-free', 'original-popup', 'original-redact', 'original-reply']);
      const free = annots.get('original-free')!; const popup = annots.get('original-popup')!;
      assert.equal(free.get('Popup').asIndirect(), popup.asIndirect()); assert.equal(popup.get('Parent').asIndirect(), free.asIndirect());
      assert.equal(annots.get('original-reply')!.get('IRT').asIndirect(), free.asIndirect());
      assert.equal(annots.get('original-link')!.get('Dest', 0).asIndirect(), pdf.findPage(0).asIndirect());
      assert.equal(annots.get('original-redact')!.get('Subtype').asName(), 'Redact');
      assert.equal(free.get('Contents').asString(), 'Kept annotation');
      for (const annot of annots.values()) assert.equal(annot.get('P').asIndirect(), pdf.findPage(0).asIndirect());
    } finally { pdf.destroy(); }
    unchangedOutside(directRender(bytes), directRender(out), [38, 65, 262, 112]);
    assert.ok(extractedText(out).includes(REPLACEMENT)); assert.ok(!extractedText(out).includes(ORIGINAL));
  } finally { api.close(); }
});

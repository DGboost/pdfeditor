import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativePdfApi } from '../src/pdf/nativeDocument';
import type { PdfPage, QuarterTurn } from '../src/types/pdfEditor';
import { annotations, directRender, extractedText, fidelityFixture, GEOMETRIES, geometryFixture, loadFont, mergedWidgetFixture, mupdf, ORIGINAL, pdfPage, REPLACEMENT, saved, textContent, widgetFixture, workspace } from './fixtures';

function arrayNumbers(object: mupdf.PDFObject): number[] {
  const values: number[] = []; object.forEach(value => values.push(value.asNumber())); return values;
}

function compareNumbers(actual: number[], expected: number[], tolerance = 0.01): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance, `${value} differs from ${expected[index]} at ${index}`));
}

function inherited(object: mupdf.PDFObject, key: string): mupdf.PDFObject {
  const seen = new Set<number>();
  while (!object.isNull()) {
    const value = object.get(key); if (!value.isNull()) return value;
    const ref = object.asIndirect(); assert.equal(seen.has(ref), false, 'Field parent cycle'); seen.add(ref);
    object = object.get('Parent');
  }
  return mupdf.PDFObject.Null;
}

function widgets(pdf: mupdf.PDFDocument, index: number): mupdf.PDFObject[] {
  const result: mupdf.PDFObject[] = [];
  pdf.findPage(index).get('Annots').forEach(annot => { if (annot.get('Subtype').asName() === 'Widget') result.push(annot); });
  return result;
}

function fieldTree(pdf: mupdf.PDFDocument): Set<number> {
  const visited = new Set<number>();
  const pageRefs = new Set(Array.from({ length: pdf.countPages() }, (_, index) => pdf.findPage(index).asIndirect()));
  const visit = (node: mupdf.PDFObject, parent: mupdf.PDFObject | null) => {
    const ref = node.asIndirect(); assert.equal(visited.has(ref), false, 'Fields/Kids must form independent trees, not aliases or cycles'); visited.add(ref);
    if (parent) assert.equal(node.get('Parent').asIndirect(), parent.asIndirect(), 'Every child points only to its actual field ancestor');
    else assert.equal(node.get('Parent').isNull(), true, 'Root has no original ancestor');
    if (node.get('Subtype').asName() === 'Widget') assert.equal(pageRefs.has(node.get('P').asIndirect()), true, 'Retained widget /P must remain in page tree');
    node.get('Kids').forEach(child => visit(child, node));
  };
  pdf.getTrailer().get('Root', 'AcroForm', 'Fields').forEach(root => visit(root, null));
  for (let index = 0; index < pdf.countPages(); index++) for (const widget of widgets(pdf, index)) assert.equal(visited.has(widget.asIndirect()), true, 'Every page widget belongs to field tree');
  pdf.getTrailer().get('Root', 'AcroForm', 'CO').forEach(field => assert.equal(visited.has(field.asIndirect()), true, 'Calculation order cannot reference a removed field'));
  return visited;
}

for (const rotation of [0, 90, 180, 270] as QuarterTurn[]) {
  test(`all source boxes/Rotate/UserUnit with user rotation ${rotation}: preview equals export/reopen including NoRotate annotation`, async () => {
    const bytes = geometryFixture(); const api = createNativePdfApi(loadFont, () => {});
    try {
      const info = await api.open(new Blob([Uint8Array.from(bytes)]));
      assert.equal(info.pages.length, GEOMETRIES.length);
      const pages = GEOMETRIES.map((_, index) => ({ ...pdfPage(index), rotation }));
      // Reverse pages also exercises inherited boxes and stable source identity, not index parsing.
      pages.reverse(); const output = await api.export(workspace(bytes, pages));
      const pdf = new mupdf.PDFDocument(output);
      try {
        assert.equal(pdf.countPages(), pages.length); assert.equal(pdf.getTrailer().get('Root', 'Lang').asString(), 'ko-KR');
        for (let index = 0; index < pages.length; index++) {
          const page = pages[index]; const geometry = GEOMETRIES[page.sourcePageIndex]; const object = pdf.findPage(index);
          compareNumbers(arrayNumbers(object.getInheritable('MediaBox')), geometry.media);
          compareNumbers(arrayNumbers(object.getInheritable('CropBox')), geometry.crop);
          assert.equal(object.getInheritable('Rotate').asNumber(), (geometry.rotate + rotation) % 360);
          assert.equal(object.get('UserUnit').asNumber(), geometry.unit);
          assert.equal(object.get('Group', 'S').asName(), 'Transparency');
          const native = pdf.loadPage(index);
          try {
            const bounds = native.getBounds('CropBox'); const cropWidth = (geometry.crop[2] - geometry.crop[0]) * geometry.unit; const cropHeight = (geometry.crop[3] - geometry.crop[1]) * geometry.unit;
            const swap = (geometry.rotate + rotation) % 180 !== 0;
            compareNumbers([bounds[2] - bounds[0], bounds[3] - bounds[1]], swap ? [cropHeight, cropWidth] : [cropWidth, cropHeight]);
          } finally { native.destroy(); }
          const reference = directRender(output, index, 0.75); const preview = await api.render(page, 0.75);
          const independent = new mupdf.PDFDocument(bytes);
          let expected;
          try {
            independent.findPage(page.sourcePageIndex).put('Rotate', (geometry.rotate + rotation) % 360);
            expected = directRender(saved(independent), page.sourcePageIndex, 0.75);
          } finally { independent.destroy(); }
          assert.equal(reference.width, expected.width); assert.equal(reference.height, expected.height);
          assert.deepEqual(reference.rgba, expected.rgba, 'Export must match untouched source with only the expected rotation applied');
          assert.equal(preview.width, reference.width); assert.equal(preview.height, reference.height); assert.deepEqual(preview.rgba, reference.rgba);
          compareNumbers(preview.displayBounds, reference.bounds);
          assert.equal(annotations(pdf, index).get('no-rotate')!.get('F').asNumber() & 16, 16);
        }
      } finally { pdf.destroy(); }
    } finally { api.close(); }
  });
}

test('copy-on-write isolates shared content/resources/Form XObject when duplicate precedes original', async () => {
  const bytes = geometryFixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const line = (await api.text(0)).lines.find(line => line.text === 'Shared original 123'); assert.ok(line); assert.equal(line.editable, true, line.reason);
    const duplicate: PdfPage = { ...pdfPage(0, 'duplicate-first'), originalInstance: false, textEdits: [{ lineIds: [line.lineId], widthPt: 230, content: textContent('독립 복제 456') }] };
    const pages = [duplicate, pdfPage(4), pdfPage(0), pdfPage(2), pdfPage(1), pdfPage(3)];
    assert.deepEqual(await api.validate(duplicate), { ok: true });
    const out = await api.export(workspace(bytes, pages));
    assert.ok(extractedText(out, 0).includes('독립 복제 456')); assert.ok(!extractedText(out, 0).includes('Shared original 123'));
    for (let index = 1; index < pages.length; index++) {
      assert.deepEqual(directRender(out, index).rgba, directRender(bytes, pages[index].sourcePageIndex).rgba, `Shared source ${pages[index].sourcePageIndex} changed`);
      assert.ok(extractedText(out, index).includes('Shared original 123'));
    }
    const pdf = new mupdf.PDFDocument(out);
    try {
      assert.notEqual(pdf.findPage(0).asIndirect(), pdf.findPage(2).asIndirect());
      assert.equal(pdf.findPage(0).get('StructParents').isNull(), true);
      assert.equal(pdf.findPage(2).get('StructParents').asNumber(), 7);
      assert.equal(pdf.findPage(0).get('Group', 'S').asName(), 'Transparency');
    } finally { pdf.destroy(); }
    assert.deepEqual(await api.export(workspace(bytes, GEOMETRIES.map((_, index) => pdfPage(index)))), bytes);
  } finally { api.close(); }
});

test('original and duplicate have independent text edits even if original instance is subsequently deleted', async () => {
  const bytes = await fidelityFixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const line = (await api.text(0)).lines.find(line => line.text === ORIGINAL); assert.ok(line);
    const original = { ...pdfPage(0), textEdits: [{ lineIds: [line.lineId], widthPt: 220, content: textContent('계약금 55,000원') }] };
    const duplicate = { ...pdfPage(0, 'independent-copy'), originalInstance: false, textEdits: [{ lineIds: [line.lineId], widthPt: 220, content: textContent(REPLACEMENT) }] };
    const both = await api.export(workspace(bytes, [duplicate, original]));
    assert.ok(extractedText(both, 0).includes(REPLACEMENT)); assert.ok(extractedText(both, 1).includes('계약금 55,000원'));
    assert.ok(!extractedText(both, 0).includes('계약금 55,000원'));
    const onlyCopy = await api.export(workspace(bytes, [duplicate]));
    const reopened = new mupdf.PDFDocument(onlyCopy);
    try { assert.equal(reopened.countPages(), 1); } finally { reopened.destroy(); }
    assert.deepEqual(directRender(onlyCopy).rgba, directRender(both, 0).rgba);
  } finally { api.close(); }
});

test('duplicated annotation relationships and self-link destinations point to duplicate, not original', async () => {
  const bytes = await fidelityFixture({ annotations: true }); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const duplicate = { ...pdfPage(0, 'annot-copy'), originalInstance: false };
    const out = await api.export(workspace(bytes, [duplicate, pdfPage(0)])); const pdf = new mupdf.PDFDocument(out);
    try {
      const copied = annotations(pdf, 0); const original = annotations(pdf, 1);
      assert.deepEqual([...copied.keys()], [...original.keys()]);
      for (const [name, annot] of copied) {
        assert.notEqual(annot.asIndirect(), original.get(name)!.asIndirect());
        assert.equal(annot.get('P').asIndirect(), pdf.findPage(0).asIndirect());
      }
      assert.equal(copied.get('original-free')!.get('Popup').asIndirect(), copied.get('original-popup')!.asIndirect());
      assert.equal(copied.get('original-popup')!.get('Parent').asIndirect(), copied.get('original-free')!.asIndirect());
      assert.equal(copied.get('original-reply')!.get('IRT').asIndirect(), copied.get('original-free')!.asIndirect());
      assert.equal(copied.get('original-link')!.get('Dest', 0).asIndirect(), pdf.findPage(0).asIndirect());
      assert.equal(original.get('original-link')!.get('Dest', 0).asIndirect(), pdf.findPage(1).asIndirect());
    } finally { pdf.destroy(); }
    assert.deepEqual(directRender(out, 0).rgba, directRender(bytes).rgba); assert.deepEqual(directRender(out, 1).rgba, directRender(bytes).rgba);
  } finally { api.close(); }
});

test('nested shared widget clone preserves inherited value/AP and changes only its own field tree', async () => {
  const bytes = widgetFixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    const info = await api.open(new Blob([Uint8Array.from(bytes)])); assert.equal(info.pages[0].duplicate.allowed, true);
    const duplicate = { ...pdfPage(0, 'widget-copy'), originalInstance: false };
    const out = await api.export(workspace(bytes, [duplicate, pdfPage(0), pdfPage(1), pdfPage(2)])); const pdf = new mupdf.PDFDocument(out);
    try {
      fieldTree(pdf);
      const copyWidget = widgets(pdf, 0)[0]; const first = widgets(pdf, 1)[0]; const second = widgets(pdf, 2)[0];
      assert.equal(inherited(copyWidget, 'FT').asName(), 'Tx'); assert.equal(inherited(copyWidget, 'V').asString(), 'original-value');
      assert.equal(first.get('Parent').asIndirect(), second.get('Parent').asIndirect());
      assert.notEqual(copyWidget.get('Parent').asIndirect(), first.get('Parent').asIndirect());
      assert.equal(copyWidget.get('Parent', 'Kids').length, 1); assert.equal(first.get('Parent', 'Kids').length, 2);
      const rootNames: string[] = []; pdf.getTrailer().get('Root', 'AcroForm', 'Fields').forEach(root => rootNames.push(root.get('T').asString()));
      assert.deepEqual(rootNames.sort(), ['copy_widget-copy_customer', 'customer'].sort());
      for (let index = 0; index < 3; index++) assert.deepEqual(directRender(out, index).rgba, directRender(bytes, index === 2 ? 1 : 0).rgba);
      const native = pdf.loadPage(0);
      try {
        const nativeWidgets = native.getWidgets(); assert.equal(nativeWidgets.length, 1);
        assert.equal(nativeWidgets[0].getValue(), 'original-value'); assert.notEqual(nativeWidgets[0].setTextValue('copy-only-value'), 0);
        native.update();
      } finally { native.destroy(); }
      const modified = saved(pdf); const reopened = new mupdf.PDFDocument(modified);
      try {
        fieldTree(reopened);
        assert.equal(inherited(widgets(reopened, 0)[0], 'V').asString(), 'copy-only-value');
        assert.equal(inherited(widgets(reopened, 1)[0], 'V').asString(), 'original-value');
        assert.equal(inherited(widgets(reopened, 2)[0], 'V').asString(), 'original-value');
        assert.deepEqual(directRender(modified, 1).rgba, directRender(out, 1).rgba); assert.deepEqual(directRender(modified, 2).rgba, directRender(out, 2).rgba);
      } finally { reopened.destroy(); }
    } finally { pdf.destroy(); }
  } finally { api.close(); }
});

test('deleting one shared-widget page preserves surviving widget/value/CO; deleting last removes empty ancestors/CO', async () => {
  const bytes = widgetFixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const one = await api.export(workspace(bytes, [pdfPage(1), pdfPage(2)])); const first = new mupdf.PDFDocument(one);
    try {
      fieldTree(first); const widget = widgets(first, 0)[0];
      assert.equal(widget.get('Parent', 'Kids').length, 1); assert.equal(widget.get('Parent', 'Kids', 0).asIndirect(), widget.asIndirect());
      assert.equal(inherited(widget, 'V').asString(), 'original-value');
      assert.equal(first.getTrailer().get('Root', 'AcroForm', 'CO').length, 1);
      assert.deepEqual(directRender(one, 0).rgba, directRender(bytes, 1).rgba);
    } finally { first.destroy(); }
    const none = await api.export(workspace(bytes, [pdfPage(2)])); const second = new mupdf.PDFDocument(none);
    try {
      fieldTree(second); assert.equal(second.getTrailer().get('Root', 'AcroForm', 'Fields').length, 0); assert.equal(second.getTrailer().get('Root', 'AcroForm', 'CO').length, 0);
      assert.equal(widgets(second, 0).length, 0);
    } finally { second.destroy(); }
  } finally { api.close(); }
});

test('page-reference destinations follow reorder but are removed on original deletion rather than retargeted to copy', async () => {
  const bytes = widgetFixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const moved = await api.export(workspace(bytes, [pdfPage(2), pdfPage(1), pdfPage(0)])); const reordered = new mupdf.PDFDocument(moved);
    try {
      assert.equal(reordered.findPage(0).get('Annots', 0, 'Dest', 0).asIndirect(), reordered.findPage(2).asIndirect());
      assert.equal(reordered.getTrailer().get('Root', 'Outlines', 'First', 'Dest', 0).asIndirect(), reordered.findPage(2).asIndirect());
    } finally { reordered.destroy(); }
    const duplicate = { ...pdfPage(0, 'replacement-is-not-original'), originalInstance: false };
    const removed = await api.export(workspace(bytes, [duplicate, pdfPage(1), pdfPage(2)])); const pdf = new mupdf.PDFDocument(removed);
    try {
      fieldTree(pdf);
      pdf.findPage(2).get('Annots').forEach(annot => assert.equal(annot.get('Dest').isNull(), true));
      assert.equal(pdf.getTrailer().get('Root', 'Outlines', 'First', 'Dest').isNull(), true);
    } finally { pdf.destroy(); }
  } finally { api.close(); }
});

for (const kind of ['xfa', 'signature'] as const) {
  test(`${kind} duplication is explicitly blocked without changing source, while unrelated page operations remain available`, async () => {
    const bytes = widgetFixture(kind); const api = createNativePdfApi(loadFont, () => {});
    try {
      const info = await api.open(new Blob([Uint8Array.from(bytes)])); const capability = info.pages[0].duplicate;
      assert.equal(capability.allowed, false); if (capability.allowed) assert.fail('Forbidden duplication was advertised');
      assert.equal(capability.code, kind === 'xfa' ? 'XFA' : 'SIGNATURE'); assert.ok(capability.reason);
      if (kind === 'signature') { assert.equal(info.hasSignatures, true); assert.equal(info.pages[2].duplicate.allowed, true); }
      const original = [pdfPage(0), pdfPage(1), pdfPage(2)]; const duplicate = { ...pdfPage(0, 'forbidden-copy'), originalInstance: false };
      await assert.rejects(api.export(workspace(bytes, [duplicate, ...original])));
      assert.deepEqual(await api.export(workspace(bytes, original)), bytes);
      assert.deepEqual((await api.render(original[0], 1)).rgba, directRender(bytes).rgba);
      const rotated = original.map(page => ({ ...page, rotation: 90 as const }));
      const out = await api.export(workspace(bytes, rotated));
      assert.deepEqual((await api.render(rotated[0], 1)).rgba, directRender(out).rgba);
    } finally { api.close(); }
  });
}

test('blank insertion has requested point dimensions and rotation without added content', async () => {
  const bytes = geometryFixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const blank = { id: 'blank', label: 'Blank', kind: 'blank' as const, widthPt: 300, heightPt: 200, rotation: 90 as const };
    const pages = [pdfPage(0), blank]; const out = await api.export(workspace(bytes, pages));
    const pdf = new mupdf.PDFDocument(out);
    try {
      assert.equal(pdf.countPages(), 2); compareNumbers(arrayNumbers(pdf.findPage(1).get('MediaBox')), [0, 0, 300, 200]);
      assert.equal(pdf.findPage(1).get('Rotate').asNumber(), 90);
      const page = pdf.loadPage(1); const text = page.toStructuredText('vectors,preserve-images');
      try { let images = 0; let vectors = 0; text.walk({ onImageBlock() { images++; }, onVector() { vectors++; } }); assert.equal(images, 0); assert.equal(vectors, 0); }
      finally { text.destroy(); page.destroy(); }
    } finally { pdf.destroy(); }
    assert.deepEqual(directRender(out, 0).rgba, directRender(bytes).rgba); assert.deepEqual((await api.render(blank, 1)).rgba, directRender(out, 1).rgba);
  } finally { api.close(); }
});

test('merged field/widget is cloned once and is the same object in page Annots and AcroForm.Fields', async () => {
  const bytes = mergedWidgetFixture(); const api = createNativePdfApi(loadFont, () => {});
  try {
    await api.open(new Blob([Uint8Array.from(bytes)]));
    const copy = { ...pdfPage(0, 'merged-copy'), originalInstance: false };
    const out = await api.export(workspace(bytes, [copy, pdfPage(0)])); const pdf = new mupdf.PDFDocument(out);
    try {
      fieldTree(pdf);
      const copyWidget = widgets(pdf, 0)[0]; const originalWidget = widgets(pdf, 1)[0];
      const roots: number[] = []; pdf.getTrailer().get('Root', 'AcroForm', 'Fields').forEach(root => roots.push(root.asIndirect()));
      assert.equal(roots.length, 2);
      assert.equal(roots.includes(copyWidget.asIndirect()), true); assert.equal(roots.includes(originalWidget.asIndirect()), true);
      assert.notEqual(copyWidget.asIndirect(), originalWidget.asIndirect());
      assert.equal(copyWidget.get('Parent').isNull(), true); assert.equal(copyWidget.get('V').asString(), 'merged-value');
      copyWidget.put('V', pdf.newString('changed-copy'));
      const changed = saved(pdf); const reopened = new mupdf.PDFDocument(changed);
      try {
        assert.equal(widgets(reopened, 0)[0].get('V').asString(), 'changed-copy');
        assert.equal(widgets(reopened, 1)[0].get('V').asString(), 'merged-value');
      } finally { reopened.destroy(); }
    } finally { pdf.destroy(); }
    assert.deepEqual(directRender(out, 0).rgba, directRender(bytes).rgba); assert.deepEqual(directRender(out, 1).rgba, directRender(bytes).rgba);
  } finally { api.close(); }
});

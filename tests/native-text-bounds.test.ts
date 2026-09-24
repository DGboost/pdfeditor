import assert from 'node:assert/strict';
import test from 'node:test';
import * as mupdf from 'mupdf';
import { NativeTextStore, intersects } from '../src/pdf/nativeText';

for (const transparentNeighbor of [false, true]) {
  test(`cross-line paint overlap outside metric bounds remains protected (${transparentNeighbor ? 'unsafe neighbor' : 'opaque neighbor'})`, () => {
    const pdf = new mupdf.PDFDocument();
    const store = new NativeTextStore(async () => { throw new Error('Unexpected font download'); });
    try {
      // Type3 metrics deliberately understate the glyph's painted ascent.
      const glyph = pdf.addStream('500 0 0 0 500 1500 d1 0 0 500 1500 re f', {});
      const font = pdf.addObject({ Type:'Font', Subtype:'Type3', Name:'Test', FontBBox:[0,0,500,500], FontMatrix:[.001,0,0,.001,0,0], CharProcs:{A:glyph}, Encoding:{Type:'Encoding',Differences:[65,'A']}, FirstChar:65, LastChar:65, Widths:[500], Resources:{} });
      const page = pdf.addPage([0,0,300,300], 0, { Font:{F0:font}, ExtGState:{Fade:{ca:.5}} },
        `BT /F0 20 Tf 1 0 0 1 40 100 Tm (A) Tj ET ${transparentNeighbor ? '/Fade gs' : ''} BT /F0 20 Tf 1 0 0 1 45 125 Tm (A) Tj ET`);
      try { pdf.insertPage(-1, page); } finally { page.destroy(); font.destroy(); glyph.destroy(); }
      const lines = store.extract(pdf, 0).lines;
      assert.equal(lines.length, 2);
      assert.equal(intersects(lines[0].bounds, lines[1].bounds), false);
      assert.ok(lines[0].chars[0].paintBounds);
      assert.equal(intersects(lines[0].chars[0].paintBounds, lines[1].bounds), true);
      assert.equal(lines[0].editable, false);
      assert.equal(lines[1].editable, false);
      assert.equal(lines[0].chars[0].redactionQuad, undefined);
      if (transparentNeighbor) assert.equal(lines[1].chars[0].paintBounds, undefined);
      else assert.ok(lines[1].chars[0].paintBounds);
    } finally { store.close(); pdf.destroy(); }
  });
}

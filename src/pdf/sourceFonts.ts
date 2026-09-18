import * as mupdf from 'mupdf';
import type { SourceFontInfo } from './engineTypes';
import { findCatalogFace } from './fontCatalog';

const standard14: Record<string, true> = {
  Courier: true, 'Courier-Bold': true, 'Courier-Oblique': true, 'Courier-BoldOblique': true,
  Helvetica: true, 'Helvetica-Bold': true, 'Helvetica-Oblique': true, 'Helvetica-BoldOblique': true,
  'Times-Roman': true, 'Times-Bold': true, 'Times-Italic': true, 'Times-BoldItalic': true,
  Symbol: true, ZapfDingbats: true,
};
const normalizedName = (name: string) => name.replace(/^[A-Z]{6}\+/, '');
type Declaration = { names: string[]; embedded: boolean; programId?: number; type3: boolean; type3Id?: number; builtin: boolean; weight?: number; italic?: boolean; conflict: boolean; identityConflict?: boolean };

function nameValue(object: mupdf.PDFObject, key: string): string | undefined {
  const value = object.get(key);
  try {
    if (value.isNull()) return undefined;
    if (!value.isName()) throw new Error('Invalid font name');
    return value.asName();
  } finally { value.destroy(); }
}
function numberValue(object: mupdf.PDFObject, key: string): number | undefined {
  const value = object.get(key);
  try {
    if (value.isNull()) return undefined;
    if (!value.isNumber() || !Number.isFinite(value.asNumber())) throw new Error('Invalid font style');
    return value.asNumber();
  } finally { value.destroy(); }
}

function inspectFont(font: mupdf.PDFObject): Declaration {
  if (!font.isDictionary()) throw new Error('Invalid font dictionary');
  const subtype = nameValue(font, 'Subtype');
  const result: Declaration = { names: [], embedded: false, type3: subtype === 'Type3', builtin: false, conflict: false };
  const addName = (name: string | undefined) => { if (name) result.names.push(name); };
  if (result.type3) {
    addName(nameValue(font, 'Name') ?? `Type3 (${font.isIndirect() ? font.asIndirect() : 0} 0 R)`);
    const resolved = font.resolve();
    try { result.type3Id = resolved.pointer; } finally { resolved.destroy(); }
  }
  addName(nameValue(font, 'BaseFont'));
  const inspectDescriptor = (owner: mupdf.PDFObject) => {
    addName(nameValue(owner, 'BaseFont'));
    const descriptor = owner.get('FontDescriptor');
    try {
      if (descriptor.isNull()) return;
      if (!descriptor.isDictionary()) throw new Error('Invalid font descriptor');
      addName(nameValue(descriptor, 'FontName'));
      const weight = numberValue(descriptor, 'FontWeight');
      const angle = numberValue(descriptor, 'ItalicAngle');
      const flags = numberValue(descriptor, 'Flags');
      const italicFlag = flags !== undefined && (flags & 64) !== 0;
      const italic = angle !== undefined ? angle !== 0 : italicFlag ? true : undefined;
      if (angle === 0 && italicFlag) result.conflict = true;
      if (weight !== undefined) {
        if (weight < 100 || weight > 900 || !Number.isInteger(weight) || (result.weight !== undefined && result.weight !== weight)) result.conflict = true;
        result.weight = weight;
      }
      if (italic !== undefined) {
        if (result.italic !== undefined && result.italic !== italic) result.conflict = true;
        result.italic = italic;
      }
      let streams = 0;
      for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
        const stream = descriptor.get(key);
        try {
          if (!stream.isNull()) {
            if (!stream.isStream()) result.conflict = true;
            else {
              streams++;
              const resolved = stream.resolve();
              try { result.programId = resolved.pointer; } finally { resolved.destroy(); }
              try {
                const buffer = stream.readStream();
                try {
                  const parsed = new mupdf.Font(result.names[0] ?? '', buffer);
                  parsed.destroy();
                } finally { buffer.destroy(); }
              } catch { result.conflict = true; }
            }
          }
        } finally { stream.destroy(); }
      }
      if (streams > 1) result.conflict = true;
      result.embedded ||= streams > 0;
    } finally { descriptor.destroy(); }
  };
  inspectDescriptor(font);
  if (subtype === 'Type0') {
    const descendants = font.get('DescendantFonts');
    try {
      if (result.embedded) result.conflict = true; // Type0 programs belong to the descendant, not the wrapper.
      if (!descendants.isArray() || descendants.length !== 1) result.conflict = true;
      if (descendants.isArray()) descendants.forEach(descendant => {
        try {
          const childSubtype = nameValue(descendant, 'Subtype');
          if (!descendant.isDictionary() || (childSubtype !== 'CIDFontType0' && childSubtype !== 'CIDFontType2')) result.conflict = true;
          inspectDescriptor(descendant);
        } finally { descendant.destroy(); }
      });
    } finally { descendants.destroy(); }
  } else if (!['Type1', 'MMType1', 'TrueType', 'Type3'].includes(subtype ?? '')) result.conflict = true;
  const names = new Set(result.names.map(normalizedName));
  const subsets = new Set(result.names.filter(name => /^[A-Z]{6}\+/.test(name)));
  result.identityConflict = names.size > 1 || subsets.size > 1;
  if (names.size === 0 || (result.identityConflict && !result.embedded)) result.conflict = true;
  result.builtin = subtype === 'Type1' && result.names.length > 0 && result.names.every(name => standard14[name] === true);
  if (result.builtin) {
    const name = result.names[0];
    if ((result.weight !== undefined && result.weight !== (name.includes('Bold') ? 700 : 400)) ||
        (result.italic !== undefined && result.italic !== /Italic|Oblique/.test(name))) result.conflict = true;
  }
  return result;
}

/** Inspect PDF declarations, not MuPDF's potentially substituted native font name. */
export function collectSourceFonts(pdf: mupdf.PDFDocument, index: number): (fontKey: string, nativeName: string) => SourceFontInfo {
  const declarations = new Map<string, Declaration>();
  const visited = new Set<number>();
  let incomplete = false;
  const scan = (resources: mupdf.PDFObject) => {
    if (resources.isNull()) return;
    if (!resources.isDictionary()) throw new Error('Invalid resources');
    const resolved = resources.resolve();
    try {
      if (visited.has(resolved.pointer)) return;
      visited.add(resolved.pointer);
      const fonts = resources.get('Font');
      try {
        if (!fonts.isNull() && !fonts.isDictionary()) throw new Error('Invalid font resources');
        fonts.forEach(font => {
          try {
            const declaration = inspectFont(font);
            for (const name of new Set(declaration.names.map(normalizedName))) {
              const previous = declarations.get(name);
              if (previous) {
                const conflict = previous.conflict || declaration.conflict || previous.embedded !== declaration.embedded || previous.programId !== declaration.programId || previous.type3 !== declaration.type3 || previous.type3Id !== declaration.type3Id || previous.builtin !== declaration.builtin || previous.weight !== declaration.weight || previous.italic !== declaration.italic;
                previous.conflict = declaration.conflict = conflict;
                previous.identityConflict = declaration.identityConflict = previous.identityConflict || declaration.identityConflict;
              } else declarations.set(name, declaration);
            }
          } catch { incomplete = true; }
          finally { font.destroy(); }
        });
      } finally { fonts.destroy(); }
      const objects = resources.get('XObject');
      try {
        if (!objects.isNull() && !objects.isDictionary()) throw new Error('Invalid XObject resources');
        objects.forEach(object => {
          try {
            if (nameValue(object, 'Subtype') === 'Form') {
              const nested = object.get('Resources');
              try { scan(nested); } finally { nested.destroy(); }
            }
          } finally { object.destroy(); }
        });
      } finally { objects.destroy(); }
    } finally { resolved.destroy(); }
  };
  const page = pdf.findPage(index);
  try {
    const resources = page.getInheritable('Resources');
    try { scan(resources); } finally { resources.destroy(); }
  } catch { incomplete = true; }
  finally { page.destroy(); }

  return (fontKey, nativeName) => {
    const declaration = declarations.get(normalizedName(nativeName));
    const unknown = (unavailableReason: string): SourceFontInfo => ({ sourcePageIndex: index, fontKey, declaredName: declaration?.names[0] ?? nativeName, embedded: 'unknown', usable: false, unavailableReason });
    if (incomplete) return unknown('PDF 글꼴 리소스를 완전히 확인할 수 없어 원본 글꼴을 안전하게 식별할 수 없습니다.');
    if (!declaration) return unknown('표시된 글꼴과 PDF에 선언된 글꼴이 일치하지 않아 원본 글꼴을 확인할 수 없습니다.');
    if (declaration.conflict) return unknown('PDF의 글꼴 이름, 포함 여부 또는 스타일 선언이 서로 충돌합니다. 대체 글꼴을 선택해 주세요.');
    const name = normalizedName(declaration.names[0]);
    const face = declaration.identityConflict || declaration.type3 || declaration.builtin ? undefined : findCatalogFace(name);
    const styleConflict = face && ((declaration.weight !== undefined && declaration.weight !== face.weight) || (declaration.italic !== undefined && declaration.italic !== face.italic));
    const catalog = styleConflict ? undefined : face;
    const usable = declaration.embedded || declaration.type3 || declaration.builtin;
    return {
      sourcePageIndex: index, fontKey, declaredName: declaration.names[0], embedded: declaration.embedded, usable,
      ...(declaration.weight !== undefined ? { weight: declaration.weight } : {}),
      ...(declaration.italic !== undefined ? { italic: declaration.italic } : {}),
      ...(catalog ? { catalogId: catalog.id, family: catalog.family, weight: catalog.weight, italic: catalog.italic } : {}),
      ...(!usable ? { unavailableReason: styleConflict
        ? 'PDF의 글꼴 스타일 선언이 지원 글꼴과 일치하지 않습니다. 대체 글꼴을 선택해 주세요.'
        : catalog ? '원본 글꼴이 PDF에 포함되어 있지 않습니다. 정확한 글꼴을 다운로드하거나 대체 글꼴을 선택해 주세요.'
          : '원본 글꼴이 PDF에 포함되어 있지 않으며 정확히 일치하는 지원 글꼴이 없습니다. 대체 글꼴을 선택해 주세요.' } : {}),
    };
  };
}

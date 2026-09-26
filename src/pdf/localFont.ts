import type { LocalFontAsset } from '../types/pdfEditor';
import type { SourceFontInfo } from './engineTypes';
import { sha256Hex } from '../utils/crypto';

export interface SfntFace {
  index: number; postScriptName: string; fullNames: string[]; families: string[];
  weight: number; italic: boolean; fsType: number;
}

const utf16 = (bytes: Uint8Array) => { let text = ''; for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]); return text; };

function readFace(bytes: Uint8Array, view: DataView, offset: number, index: number): SfntFace {
  const version = view.getUint32(offset);
  if (version !== 0x00010000 && version !== 0x4f54544f && version !== 0x74727565) throw new Error('unsupported sfnt');
  const tables = new Map<string, number>();
  for (let i = 0, count = view.getUint16(offset + 4); i < count; i++) {
    const record = offset + 12 + i * 16;
    tables.set(String.fromCharCode(...bytes.subarray(record, record + 4)), view.getUint32(record + 8));
  }
  const name = tables.get('name'), os2 = tables.get('OS/2');
  if (name === undefined || os2 === undefined) throw new Error('missing name or OS/2 table');
  const names = new Map<number, Set<string>>();
  const storage = name + view.getUint16(name + 4);
  for (let i = 0, count = view.getUint16(name + 2); i < count; i++) {
    const record = name + 6 + i * 12;
    const platform = view.getUint16(record), encoding = view.getUint16(record + 2), id = view.getUint16(record + 6);
    const start = storage + view.getUint16(record + 10), raw = bytes.subarray(start, start + view.getUint16(record + 8));
    if (raw.length !== view.getUint16(record + 8)) throw new Error('truncated name');
    const text = platform === 0 || platform === 3 ? utf16(raw) : platform === 1 && encoding === 0 ? String.fromCharCode(...raw) : '';
    if (text.trim()) { if (!names.has(id)) names.set(id, new Set()); names.get(id)!.add(text.trim()); }
  }
  const all = (...ids: number[]) => ids.flatMap(id => [...(names.get(id) ?? [])]);
  const weightClass = view.getUint16(os2 + 4);
  const postScriptName = all(6)[0] ?? all(4)[0] ?? all(16, 1)[0];
  if (!postScriptName) throw new Error('unnamed face');
  return {
    index, postScriptName, fullNames: all(6, 4), families: all(16, 1),
    weight: weightClass > 0 && weightClass < 10 ? weightClass * 100 : weightClass,
    italic: (view.getUint16(os2 + 62) & 0x0201) !== 0, fsType: view.getUint16(os2 + 8),
  };
}

/** Read every face of a TTF/OTF/TTC file; throws on anything that is not a readable SFNT font. */
export function readSfntFaces(bytes: Uint8Array): SfntFace[] {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offsets = view.getUint32(0) === 0x74746366
      ? Array.from({ length: view.getUint32(8) }, (_, i) => view.getUint32(12 + i * 4))
      : [0];
    return offsets.map((offset, index) => readFace(bytes, view, offset, index));
  } catch {
    throw new Error('TTF, OTF 또는 TTC 글꼴 파일로 읽을 수 없습니다.');
  }
}

/** Restricted-license-only and bitmap-only faces must not be embedded into a PDF. */
export function embeddingAllowed(fsType: number): boolean {
  return (fsType & 0x0200) === 0 && (fsType & 0x000e) !== 0x0002;
}

const key = (name: string) => name.normalize('NFC').toLowerCase().replace(/[\s_-]/g, '');

/** A user file stands in for the PDF font only when its SFNT identity names the same face. */
export function matchesSourceFont(info: Pick<SourceFontInfo, 'declaredName' | 'weight' | 'italic'>, face: SfntFace): boolean {
  if (info.italic !== undefined && info.italic !== face.italic) return false;
  const declared = info.declaredName.replace(/^[A-Z]{6}\+/, '');
  const comma = declared.indexOf(',');
  const families = face.families.map(key);
  if (comma >= 0) {
    // Acrobat convention for non-embedded TrueType: "Family,Bold" / "Family,Italic" / "Family,BoldItalic".
    const style = declared.slice(comma + 1);
    return families.includes(key(declared.slice(0, comma))) && (face.weight >= 600) === /bold/i.test(style) && face.italic === /italic|oblique/i.test(style);
  }
  if (face.fullNames.some(name => key(name) === key(declared))) return true;
  return families.includes(key(declared)) && face.weight === (info.weight ?? 400) && face.italic === (info.italic ?? false);
}

export async function createLocalFontAsset(bytes: Uint8Array<ArrayBuffer>, fileName: string, face: SfntFace): Promise<LocalFontAsset> {
  return { origin: 'local', id: `${await sha256Hex(bytes)}:${face.index}`, fileName, subfont: face.index,
    family: face.families[0] ?? face.postScriptName, postScriptName: face.postScriptName, weight: face.weight, italic: face.italic,
    bytes: new Blob([bytes]) };
}

/** Re-derive a stored local asset from its bytes so restored drafts cannot smuggle a different face. */
export async function verifyLocalFontAsset(asset: LocalFontAsset): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(await asset.bytes.arrayBuffer());
  const face = readSfntFaces(bytes)[asset.subfont];
  const expected = face && await createLocalFontAsset(bytes, asset.fileName, face);
  if (!face || !expected || expected.id !== asset.id || expected.postScriptName !== asset.postScriptName || expected.family !== asset.family ||
      expected.weight !== asset.weight || expected.italic !== asset.italic || !embeddingAllowed(face.fsType)) {
    throw new Error('불러온 글꼴 파일의 무결성을 확인할 수 없습니다.');
  }
  return bytes;
}

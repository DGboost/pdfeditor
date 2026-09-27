export type RegionRole =
  | 'studentName' | 'studentId' | 'grade' | 'class' | 'number'
  | 'birthdate' | 'address' | 'guardian' | 'opinion';

/** A user-confirmed mapping; unlisted targets are locked. */
export interface RegionMapping {
  id: string;
  role: RegionRole | 'locked';
  anchor: { kind: 'pdf'; pageId: string; sourcePageIndex: number; lineIds: string[]; originalText: string }
    | { kind: 'docx' | 'hwp' | 'hwpx'; locator: string; originalText: string };
  /** Last confirmed native value, saved atomically with its document checkpoint. */
  currentText: string;
}

export interface RegionConfig {
  mappings: RegionMapping[];
  reviewed: boolean;
  /** Card selection persists independently from mappings; release only removes an ID here. */
  selectedIds: string[];
}

/** Geometry is in the engine's viewport CSS pixels, not stored with the mapping. */
export interface OfficeRegionTarget {
  locator: string;
  text: string;
  boxes: { x: number; y: number; width: number; height: number }[];
  reason?: string;
}

export interface OfficeRegionController {
  targets(locators: string[]): Promise<OfficeRegionTarget[]>;
  capture(): Promise<OfficeRegionTarget | null>;
  replace(locator: string, expectedText: string, value: string, expectedRevision: number, locatorsToRebase: string[]): Promise<{ ok: true; targets: OfficeRegionTarget[] } | { ok: false; reason: string }>;
  highlight(locator: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  setMode(mode: 'normal' | 'mapping' | 'protected'): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
}

export const REGION_ROLE_LABELS: Record<RegionRole, string> = {
  studentName: '학생 이름', studentId: '학번', grade: '학년', class: '반', number: '번호',
  birthdate: '생년월일', address: '주소', guardian: '보호자 정보', opinion: '행동 특성 및 종합 의견',
};

export function validateRegionConfig(value: unknown, format: 'pdf' | 'docx' | 'hwp' | 'hwpx'): RegionConfig {
  if (!value || typeof value !== 'object' || !Array.isArray((value as RegionConfig).mappings)
    || typeof (value as RegionConfig).reviewed !== 'boolean' || !Array.isArray((value as RegionConfig).selectedIds)) throw new Error('영역 편집 설정이 올바르지 않습니다.');
  const config = value as RegionConfig;
  const identities = new Set<string>();
  const ids = new Set<string>();
  const pdfLines = new Set<string>();
  for (const mapping of config.mappings) {
    if (!mapping || typeof mapping.id !== 'string' || !mapping.id || !mapping.anchor
      || (mapping.role !== 'locked' && !Object.prototype.hasOwnProperty.call(REGION_ROLE_LABELS, mapping.role)) || typeof mapping.currentText !== 'string'
      || mapping.anchor.kind !== format || typeof mapping.anchor.originalText !== 'string') throw new Error('영역 편집 매핑이 올바르지 않습니다.');
    const anchor = mapping.anchor;
    const locator = anchor.kind === 'pdf'
      ? (typeof anchor.pageId === 'string' && anchor.pageId && Number.isSafeInteger(anchor.sourcePageIndex)
        && anchor.sourcePageIndex >= 0 && Array.isArray(anchor.lineIds) && anchor.lineIds.length
        && anchor.lineIds.every(id => typeof id === 'string' && !!id)
        ? JSON.stringify([anchor.pageId, anchor.sourcePageIndex, anchor.lineIds]) : '')
      : (typeof anchor.locator === 'string' && anchor.locator.length > 0 ? anchor.locator : '');
    if (!locator || identities.has(`${anchor.kind}:${locator}`) || ids.has(mapping.id)) throw new Error('영역 편집 대상이 중복되었거나 올바르지 않습니다.');
    if (anchor.kind === 'pdf') for (const lineId of anchor.lineIds) {
      const key = JSON.stringify([anchor.pageId, lineId]);
      if (pdfLines.has(key)) throw new Error('영역 편집 대상의 원본 줄이 중복되었습니다.');
      pdfLines.add(key);
    }
    identities.add(`${anchor.kind}:${locator}`);
    ids.add(mapping.id);
  }
  const selected = new Set<string>();
  for (const id of config.selectedIds) {
    if (typeof id !== 'string' || selected.has(id) || !config.mappings.some(mapping => mapping.id === id && mapping.role !== 'locked')) throw new Error('선택한 영역 편집 대상이 올바르지 않습니다.');
    selected.add(id);
  }
  return config;
}

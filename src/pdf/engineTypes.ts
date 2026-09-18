import type { DownloadedFontAsset, FontChoice, Matrix, Page, Point, Quad, QuarterTurn, Rect, RGB, SourceTextLayout, TextContent, Workspace } from '../types/pdfEditor';

export interface PageGeometry { bounds: Rect; pdfToPage: Matrix; sourceRotate: QuarterTurn; userUnit: number }
export type DuplicateCapability = { allowed: true } | { allowed: false; code: 'XFA' | 'SIGNATURE'; reason: string };
export interface SourcePageInfo extends PageGeometry { duplicate: DuplicateCapability }
export interface SourceInfo { pages: SourcePageInfo[]; canEdit: boolean; canAssemble: boolean; canCopy: boolean; hasSignatures: boolean }
export interface SourceCharacter { text: string; quad: Quad; origin: Point; fontKey: string; sizePt: number; color: RGB; paintBounds?: Rect; clipBounds?: Rect; redactionQuad?: Quad }
export interface SourceTextLine {
  lineId: string; text: string; bounds: Rect; origin: Point; direction: Point;
  writingMode: number; chars: SourceCharacter[]; content: TextContent; widthPt: number;
  presentationOrigins?: Point[];
  editable: boolean; reason?: string;
}
export interface SourceFontInfo {
  sourcePageIndex: number; fontKey: string; declaredName: string; embedded: boolean | 'unknown'; usable: boolean;
  catalogId?: string; family?: string; weight?: number; italic?: boolean; unavailableReason?: string;
}
export interface SourceTextPage { sourcePageIndex: number; lines: SourceTextLine[]; fonts?: SourceFontInfo[]; imageBounds?: Rect[]; rulingLines?: [Point, Point][] }
export type EditableTextTarget =
  { kind: 'source'; lineIds: string[]; bounds: Rect; quads: Quad[]; content: TextContent; widthPt: number; layout?: SourceTextLayout; editable: boolean; reason?: string };
export interface RenderedPage {
  rgba: Uint8ClampedArray; width: number; height: number; pixelOrigin: Point;
  pageToRaster: Matrix; bounds: Rect; displayBounds: Rect; textTargets: EditableTextTarget[];
}
export type EditValidation = { ok: true } | { ok: false; code: string; message: string; proposedFont?: FontChoice };
export interface NativePdfApi {
  open(source: Blob, password?: string): Promise<SourceInfo>;
  text(sourcePageIndex: number): Promise<SourceTextPage>;
  downloadFont(choice: Extract<FontChoice, { kind: 'source' }>): Promise<DownloadedFontAsset>;
  registerFonts(assets: DownloadedFontAsset[]): Promise<void>;
  copySourceText(sourcePageIndex: number, start: Point, end: Point): Promise<string>;
  validate(page: Page): Promise<EditValidation>;
  render(page: Page, scale: number): Promise<RenderedPage>;
  export(workspace: Workspace): Promise<Uint8Array>;
  close(): void;
}
export type NativeMethod = Exclude<keyof NativePdfApi, 'close'>;
export type NativeRequest = { [M in NativeMethod]: {
  requestId: number; sessionId: string; revision: number; candidateRevision: number;
  method: M; params: Parameters<NativePdfApi[M]>; priority?: 'active' | 'thumbnail';
} }[NativeMethod];
export type NativeResponse = { [M in NativeMethod]: {
  requestId: number; sessionId: string; revision: number; candidateRevision: number;
  method: M; result: Awaited<ReturnType<NativePdfApi[M]>>;
} }[NativeMethod] | {
  requestId: number; sessionId: string; revision: number; candidateRevision: number;
  error: { code: string; message: string };
} | {
  requestId: number; sessionId: string; revision: number; candidateRevision: number;
  event: 'started';
} | {
  requestId: number; sessionId: string; revision: number; candidateRevision: number;
  event: 'progress'; current: number; total: number;
};

export type Screen = 'upload' | 'editor';
export type Tool = 'pan' | 'select';
export type QuarterTurn = 0 | 90 | 180 | 270;
export type Point = [number, number];
export type Matrix = [number, number, number, number, number, number];
export type Rect = [number, number, number, number];
export type Quad = [number, number, number, number, number, number, number, number];
export type RGB = [number, number, number];
export type FontChoice =
  | { kind: 'source'; sourcePageIndex: number; fontKey: string }
  | { kind: 'downloaded'; assetId: string }
  | { kind: 'bundled'; family: 'NanumGothic' | 'NanumMyeongjo' | 'Courier'; bold: boolean };
export interface CatalogFontAsset {
  id: string; catalogId: string; family: string; postScriptName: string;
  weight: number; italic: boolean; bytes: Blob; licenseText: string; sourceUrl: string;
}
/** A font file the user obtained themselves; it never leaves this browser except inside exported PDFs. */
export interface LocalFontAsset {
  origin: 'local'; id: string; fileName: string; subfont: number; family: string; postScriptName: string;
  weight: number; italic: boolean; bytes: Blob;
}
export type DownloadedFontAsset = CatalogFontAsset | LocalFontAsset;
export interface TextStyle { font: FontChoice; sizePt: number; color: RGB }
export interface StyledRun { text: string; style: TextStyle }
export interface TextContent { runs: StyledRun[]; align: 'left' | 'center' | 'right' }
export interface SourceTextLayout {
  lineHeightPt: number; referenceSizePt: number;
  firstLineIndentPt: number; restLineIndentPt: number;
}
export interface SourceTextEdit {
  lineIds: string[]; content: TextContent; widthPt: number; layout?: SourceTextLayout;
}
export interface PageBase {
  id: string; label: string; rotation: QuarterTurn;
}
export interface PdfPage extends PageBase {
  kind: 'pdf'; sourcePageIndex: number; originalInstance: boolean; textEdits: SourceTextEdit[];
}
export interface BlankPage extends PageBase { kind: 'blank'; widthPt: number; heightPt: number }
export type Page = PdfPage | BlankPage;
export interface Workspace {
  id: string; fileName: string; source: Blob; sourceHash: string;
  pages: Page[]; activePageId: string;
  fontAssets?: DownloadedFontAsset[];
}
export interface DocumentSnapshot { pages: Page[]; activePageId: string; fontAssets?: DownloadedFontAsset[] }
export interface DocumentState {
  workspace: Workspace | null; revision: number;
  history: { undo: DocumentSnapshot[]; redo: DocumentSnapshot[] };
}
export interface EditController { flush: () => Promise<boolean>; cancel: () => void }

export type Screen = 'upload' | 'editor';

export type Tool = 'pan' | 'select' | 'text' | 'image' | 'shape' | 'signature';

export type PartyWhich = 'gap' | 'eul';

export interface TitleBlock { id: string; type: 'title'; text: string }
export interface TextBlock { id: string; type: 'text'; text: string }
export interface ClauseBlock { id: string; type: 'clause'; label: string; text: string }
export interface PartyBlock { id: string; type: 'party'; role: string; name: string; which: PartyWhich }
export type Block = TitleBlock | TextBlock | ClauseBlock | PartyBlock;

export interface ImageItem { id: string; x: number; y: number; w: number; h: number }
export interface SignatureFieldItem { id: string; x: number; y: number; w: number; h: number; signed: boolean; dataUrl: string | null }
export interface ShapeItem { id: string; x: number; y: number; w: number; h: number }
export interface TextBoxItem { id: string; x: number; y: number; w: number; h: number; text: string }

export interface PdfTextItem { id: string; left: number; top: number; width: number; height: number; text: string; fontSizePx: number }

export interface PageBase {
  id: string;
  label: string;
  images: ImageItem[];
  signatureFields: SignatureFieldItem[];
  textBoxes: TextBoxItem[];
  shapes: ShapeItem[];
  rotation: number;
}

export interface DocPage extends PageBase {
  kind: 'doc';
  blocks: Block[];
}

export interface PdfPage extends PageBase {
  kind: 'pdf';
  pending: boolean;
  textPending?: boolean;
  pdfImage?: string;
  pdfThumb?: string;
  imgW?: number;
  imgH?: number;
  textItems: PdfTextItem[];
  blocks: Block[];
}

export type Page = DocPage | PdfPage;

export interface SignatureState { signed: boolean; dataUrl: string | null }
export interface Signatures { gap: SignatureState; eul: SignatureState }

export interface SigModalTargetFixed { kind: 'fixed'; which: PartyWhich }
export interface SigModalTargetExtra { kind: 'extra'; pageId: string; id: string }
export type SigModalTarget = SigModalTargetFixed | SigModalTargetExtra;
export interface SigModalState { open: boolean; target: SigModalTarget | null }

export type ExportFormat = 'pdf' | 'archive';
export interface ExportSettings {
  format: ExportFormat;
}

export interface DocumentSnapshot {
  pages: Page[];
  signatures: Signatures;
  globalFontFamily: string | null;
  globalFontSize: number | null;
}

export type DragKind = 'images' | 'signatureFields' | 'shapes' | 'textBoxes';

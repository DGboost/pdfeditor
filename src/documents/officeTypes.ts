import type { OfficeFormat } from './formats';

export type FormatValue<T> =
  | { kind: 'uniform'; value: T }
  | { kind: 'mixed' }
  | { kind: 'unavailable'; reason: string };

export type OfficeCommand =
  | { type: 'undo' | 'redo' }
  | { type: 'bold' | 'italic' | 'underline' }
  | { type: 'fontFamily'; value: string }
  | { type: 'fontSize'; value: number }
  | { type: 'color'; value: string }
  | { type: 'zoom'; value: number };

export type CommandResult = { ok: true } | { ok: false; reason: string };

export interface OfficePageState {
  pageCount: number;
  currentPage: number;
  twoPage: boolean;
  renderRevision: number;
}

export type OfficePageCommand =
  | { type: 'goToPage'; page: number }
  | { type: 'twoPage'; value: boolean }
  | { type: 'fitWidth' };

export interface OfficePageController {
  execute(command: OfficePageCommand): Promise<CommandResult>;
  thumbnail(page: number, renderRevision: number): Promise<Blob>;
}

export interface OfficeInteractionState {
  tool: 'pan' | 'select';
  multiSelect: boolean;
  hasSelection: boolean;
  copyDisabledReason: string;
}

export type OfficeInteractionCommand =
  | { type: 'tool'; value: 'pan' | 'select' }
  | { type: 'multiSelect'; value: boolean };

export interface OfficeInteractionController {
  execute(command: OfficeInteractionCommand): Promise<CommandResult>;
  selectedText(): Promise<string>;
}

export interface OfficeState {
  sessionId: string;
  revision: number;
  selectionRevision: number;
  ready: boolean;
  busy: boolean;
  composing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canSaveModified: boolean;
  zoom: number;
  pageView?: OfficePageState;
  interaction?: OfficeInteractionState;
  enabled: Record<OfficeCommand['type'], boolean>;
  formatting: {
    bold: FormatValue<boolean>;
    italic: FormatValue<boolean>;
    underline: FormatValue<boolean>;
    fontFamily: FormatValue<string>;
    fontSize: FormatValue<number>;
    color: FormatValue<string>;
  };
  fonts: { value: string; label: string }[];
  warnings: string[];
}

export type OfficeCheckpoint =
  | { kind: 'native'; format: 'docx' | 'hwp' | 'hwpx'; bytes: Blob; warnings: string[] }
  | { kind: 'pptist'; payload: unknown; assets: { id: string; blob: Blob }[] };

export interface OfficeSession {
  pageView?: OfficePageController;
  interaction?: OfficeInteractionController;
  getState(): OfficeState;
  subscribe(listener: (state: OfficeState) => void): () => void;
  execute(command: OfficeCommand): Promise<CommandResult>;
  flush(): Promise<boolean>;
  captureCheckpoint(): Promise<{ revision: number; checkpoint: OfficeCheckpoint }>;
  serialize(): Promise<{ revision: number; bytes: Blob; warnings: string[] }>;
  dispose(): void;
}

export interface OfficeSessionOptions {
  format: OfficeFormat;
  mount: HTMLElement;
  source: Blob;
  fileName: string;
  sessionId: string;
  signal: AbortSignal;
  checkpoint?: OfficeCheckpoint;
  initialRevision?: number;
}

export type OfficeFrameOpen = Pick<OfficeSessionOptions, 'format' | 'source' | 'fileName' | 'checkpoint'> & {
  initialRevision: number;
};

export const OFFICE_COMMAND_TYPES: readonly OfficeCommand['type'][] = [
  'undo', 'redo', 'bold', 'italic', 'underline', 'fontFamily', 'fontSize', 'color', 'zoom',
];

export const OFFICE_ENGINES = {
  docx: { id: 'superdoc', version: 'superdoc-1.46.3-pdfe.1' },
  hwp: { id: 'rhwp', version: 'rhwp-0.8.6-pdfe.1' },
  hwpx: { id: 'rhwp', version: 'rhwp-0.8.6-pdfe.1' },
  pptx: { id: 'pptist', version: 'pptist-e4912589-pdfe.1' },
} as const;

export interface OfficeRecord {
  version: 1;
  id: string;
  format: OfficeFormat;
  fileName: string;
  sourceName: string;
  source: Blob;
  sourceHash: string;
  engine: { id: 'superdoc' | 'rhwp' | 'pptist'; version: string };
  checkpoint: OfficeCheckpoint | null;
  checkpointSequence: number;
  revision: number;
  modified: boolean;
  zoom: number;
  savedAt: number;
  pptxConversionAccepted: boolean;
}

export type LibraryKey =
  | { namespace: 'pdf'; kind: 'draft' | 'archive'; id: string }
  | { namespace: 'pdf'; kind: 'retained'; id: number }
  | { namespace: 'office'; kind: 'draft' | 'archive'; id: string }
  | { namespace: 'office'; kind: 'retained'; id: number };

export interface OfficeRecordSummary {
  id: string;
  format: OfficeFormat;
  fileName: string;
  savedAt: number;
}

export interface OfficeRetainedSummary {
  id: number;
  reason: string;
  savedAt: number;
}

export interface LibraryItem {
  key: LibraryKey;
  fileName: string;
  format?: 'pdf' | OfficeFormat;
  savedAt: number;
  pageCount?: number;
  reason?: string;
}

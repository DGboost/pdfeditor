import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronLeft, ChevronRight, Download, FileText, Hand, LayoutGrid, Minus, MousePointer2, Plus, Redo2, Undo2 } from 'lucide-react';
import type { DocumentState, DownloadedFontAsset, EditController, Page, TextContent, Tool, Workspace } from '../../../types/pdfEditor';
import type { DocumentActions } from '../../../hooks/useDocumentReducer';
import type { PdfDocumentController } from '../../../hooks/usePdfDocument';
import type { EditableTextTarget, RenderedPage, SourceFontInfo, SourceTextLine } from '../../../pdf/engineTypes';
import type { SaveStatus } from '../../../utils/db';
import { plainText } from '../../../pdf/textEditing';
import { buildSourceTextGroup } from '../../../pdf/sourceTextGroups';
import { ACCENT, BORDER, BORDER_STRONG, DANGER, PANEL_SHADOW, SURFACE, TEXT, TEXT_SUBTLE, CANVAS_BG, TOOLBAR_H, RAIL_CARD_H, solidAccentBtn, toolBase, toolActive } from '../../../styles/theme';
import { PdfPageSurface } from './PdfPageSurface';
import { PageThumbnail } from './GridView';
import { TextEditPanel } from './TextEditPanel';

export interface EditorScreenProps {
  workspace: Workspace; revision: number; engine: PdfDocumentController; docActions: DocumentActions;
  getDocumentState: () => DocumentState; canUndo: boolean; canRedo: boolean;
  pageNumInput: string; setPageNumInput: (s: string) => void; goToPageIndex: (i: number) => void;
  zoom: number; setZoom: (z: number) => void; isExporting: boolean; showToast: (s: string) => void;
  goToUpload: () => void; goExport: () => void; onOpenGridView: () => void;
  onDuplicatePage: (id: string) => void; onRotatePage: (id: string, delta: number) => void; onDeletePage: (id: string) => void;
  onAddPage: () => void; onReorderPages: (from: string, to: string) => void; onThumbClick: (id: string) => void;
  activeTool: Tool; setActiveTool: (t: Tool) => void;
  onFileNameChange: (s: string) => void; saveStatus: SaveStatus; onRetrySave: () => void;
  hasUnappliedEdit: boolean; onUnappliedEditChange: (v: boolean) => void;
  registerEditController: (c: EditController | null) => void;
}
interface EditSelection { target: EditableTextTarget; original?: SourceTextLine; fonts?: SourceFontInfo[]; revision: number; requiresCommit?: boolean }
const labels: Record<Tool, string> = { pan: '손 도구', select: '선택' };
const toolIcons = { pan: Hand, select: MousePointer2 };
const saveLabels: Record<SaveStatus, string> = { dirty: '저장되지 않은 변경', saving: '저장 중…', saved: '자동 저장됨', error: '저장 실패 · 다시 시도' };
export function EditorScreen(p: EditorScreenProps) {
  const { workspace, engine, docActions } = p;
  const page = workspace.pages.find(item => item.id === workspace.activePageId)!;
  const index = workspace.pages.indexOf(page);
  const [railOpen, setRailOpen] = useState(true);
  const [render, setRender] = useState<RenderedPage | null>(null);
  const [renderError, setRenderError] = useState('');
  const [selection, setSelection] = useState<EditableTextTarget | null>(null);
  const [sourceSelections, setSourceSelections] = useState<Extract<EditableTextTarget, { kind: 'source' }>[]>([]);
  const [multiSelect, setMultiSelect] = useState(false);
  const [edit, setEdit] = useState<EditSelection | null>(null);
  const [candidate, setCandidate] = useState<{ page: Page; revision: number } | null>(null);
  const [dpr, setDpr] = useState(window.devicePixelRatio || 1);
  const controller = useRef<EditController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const draggingThumb = useRef<string | null>(null);
  const selectionToken = useRef(0);
  const editable = !!engine.info?.canEdit && !p.isExporting;
  const assemble = !!engine.info?.canAssemble && !p.isExporting;
  const latest = useRef(p); latest.current = p;
  const cancel = useCallback(() => { selectionToken.current++; controller.current?.cancel(); setEdit(null); setCandidate(null); latest.current.onUnappliedEditChange(false); }, []);
  const clearSelection = useCallback(() => { cancel(); setSelection(null); setSourceSelections([]); }, [cancel]);
  const flush = useCallback(async () => controller.current ? controller.current.flush() : true, []);
  useEffect(() => {
    p.registerEditController({ flush, cancel });
    return () => p.registerEditController(null);
  }, [p.registerEditController, flush, cancel]);
  const registerPanel = useCallback((c: EditController | null) => { controller.current = c; }, []);
  const preview = useCallback((next: Page | null, revision: number) => setCandidate(next ? { page: next, revision } : null), []);
  const dirty = useCallback((value: boolean) => latest.current.onUnappliedEditChange(value), []);
  useEffect(() => { setSelection(null); setSourceSelections([]); setMultiSelect(false); setRender(null); cancel(); }, [workspace.id, page.id, cancel]);
  useEffect(() => { selectionToken.current++; setSelection(null); setSourceSelections([]); setMultiSelect(false); }, [p.activeTool]);
  useEffect(() => { selectionToken.current++; setSelection(null); setSourceSelections([]); setRender(null); }, [engine.sessionId]);
  useEffect(() => { if (edit && edit.revision !== p.revision) cancel(); }, [p.revision, edit, cancel]);
  useEffect(() => {
    if (workspace.fontAssets?.length) void engine.registerFonts(workspace.fontAssets).catch(error => latest.current.showToast(error instanceof Error ? error.message : '저장된 글꼴을 불러오지 못했습니다.'));
  }, [workspace.fontAssets, engine.registerFonts, engine.sessionId]);
  useEffect(() => {
    const resize = () => setDpr(window.devicePixelRatio || 1);
    window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    let current = true;
    setRenderError('');
    void engine.render(candidate?.page || page, 96 / 72 * p.zoom * dpr, p.revision, candidate?.revision || 0, 'active').then(result => {
      if (current) setRender(result);
    }).catch(error => { if (current) setRenderError(error instanceof Error ? error.message : '페이지 표시 실패'); });
    return () => { current = false; };
  }, [page, candidate, p.revision, p.zoom, dpr, engine.render, engine.sessionId]);
  const guarded = async (action: () => void) => { if (!p.isExporting && await flush()) action(); };
  const undo = useCallback((redo: boolean) => { if (latest.current.isExporting) return; cancel(); setSelection(null); setSourceSelections([]); if (redo) latest.current.docActions.redo(); else latest.current.docActions.undo(); }, [cancel]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && !latest.current.isExporting) { clearSelection(); return; }
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || event.isComposing) return;
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
      event.preventDefault(); undo(event.shiftKey);
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [undo, clearSelection]);
  const choose = async (target: EditableTextTarget, open: boolean, additive = false) => {
    if (latest.current.isExporting || !await flush()) return;
    const token = additive ? selectionToken.current : ++selectionToken.current;
    const state = latest.current.getDocumentState();
    const session = engine.sessionId;
    const currentPage = state.workspace?.pages.find(item => item.id === page.id);
    if (!currentPage || state.workspace?.activePageId !== page.id) return;
    try {
      let original: SourceTextLine | undefined;
      let fonts: SourceFontInfo[] | undefined;
      let resolvedTarget: EditableTextTarget;
      if (currentPage.kind === 'pdf') {
        const source = await engine.text(currentPage.sourcePageIndex);
        fonts = source.fonts;
        const sourceEdit = currentPage.textEdits.find(item => item.lineIds.includes(target.lineIds[0]));
        original = source.lines.find(line => line.lineId === target.lineIds[0]);
        if (!original) return;
        if (sourceEdit && sourceEdit.lineIds.length > 1) {
          const group = buildSourceTextGroup(currentPage, source, sourceEdit.lineIds);
          resolvedTarget = { kind: 'source', ...group, content: sourceEdit.content, widthPt: sourceEdit.widthPt, layout: sourceEdit.layout, editable: true };
          original = undefined;
        } else {
          resolvedTarget = { kind: 'source', lineIds: [original.lineId], bounds: original.bounds, quads: original.chars.map(char => char.quad), content: sourceEdit?.content || original.content, widthPt: sourceEdit?.widthPt ?? original.widthPt, editable: original.editable, reason: original.reason };
        }
      } else return;
      if (token !== selectionToken.current || latest.current.getDocumentState().revision !== state.revision || latest.current.engine.sessionId !== session) return;
      if (additive) {
        if (!resolvedTarget.editable) { p.showToast('편집 가능한 원본 텍스트만 묶을 수 있습니다.'); return; }
        const sourceTarget = resolvedTarget;
        setSourceSelections(previous => previous.some(item => item.lineIds.some(id => sourceTarget.lineIds.includes(id)))
          ? previous.filter(item => !item.lineIds.some(id => sourceTarget.lineIds.includes(id)))
          : [...previous, sourceTarget]);
        setSelection(null);
        return;
      }
      setSelection(resolvedTarget);
      setSourceSelections([resolvedTarget]);
      if (!open) return;
      if (!engine.info?.canEdit || latest.current.isExporting || !resolvedTarget.editable) { p.showToast(resolvedTarget.reason || '이 문서는 본문 편집 권한이 없습니다.'); return; }
      setEdit({ target: resolvedTarget, original, fonts, revision: state.revision });
    } catch (error) { p.showToast(error instanceof Error ? error.message : '텍스트를 열 수 없습니다.'); }
  };
  const groupSelection = async () => {
    if (!editable || sourceSelections.length < 2 || !await flush()) return;
    const token = ++selectionToken.current;
    const state = latest.current.getDocumentState();
    const session = engine.sessionId;
    const currentPage = state.workspace?.pages.find(item => item.id === page.id);
    if (currentPage?.kind !== 'pdf' || state.workspace?.activePageId !== page.id) return;
    try {
      const source = await engine.text(currentPage.sourcePageIndex);
      if (token !== selectionToken.current || latest.current.getDocumentState().revision !== state.revision || latest.current.engine.sessionId !== session) return;
      const group = buildSourceTextGroup(currentPage, source, sourceSelections.flatMap(target => target.lineIds));
      const target: EditableTextTarget = { kind: 'source', ...group, editable: true };
      setSelection(target);
      setMultiSelect(false);
      setEdit({ target, fonts: source.fonts, revision: state.revision, requiresCommit: true });
    } catch (error) { p.showToast(error instanceof Error ? error.message : '선택한 텍스트를 묶을 수 없습니다.'); }
  };
  const commit = (content: TextContent, widthPt: number, fontAssets: DownloadedFontAsset[] = []) => {
    if (!edit || !engine.info?.canEdit || p.getDocumentState().revision !== edit.revision) return;
    const target = edit.target;
    const original = edit.original;
    if (target.lineIds.length === 1 && original && original.widthPt === widthPt && JSON.stringify(original.content) === JSON.stringify(content)) docActions.removeTextEdit(page.id, target.lineIds[0]);
    else docActions.upsertTextEdit(page.id, { lineIds: target.lineIds, layout: target.layout, content, widthPt }, fontAssets);
    const committedTarget = { ...target, content, widthPt };
    setSelection(committedTarget);
    setSourceSelections([committedTarget]);
    setEdit(null); setCandidate(null); p.onUnappliedEditChange(false);
  };
  const copy = async () => {
    if (!engine.info?.canCopy || !selection) return;
    try {
      const currentContent = page.kind === 'pdf' ? page.textEdits.find(item => item.lineIds.length === selection.lineIds.length && item.lineIds.every(id => selection.lineIds.includes(id)))?.content : undefined;
      let text = plainText(currentContent || selection.content);
      if (selection.lineIds.length === 1 && page.kind === 'pdf' && !currentContent) {
        const b = selection.bounds;
        text = await engine.copySourceText(page.sourcePageIndex, [b[0], (b[1] + b[3]) / 2], [b[2], (b[1] + b[3]) / 2]);
      }
      await navigator.clipboard.writeText(text); p.showToast('텍스트를 복사했습니다.');
    } catch (error) { p.showToast(error instanceof Error ? error.message : '복사 실패'); }
  };
  const commitPageNumber = () => { const n = Number(p.pageNumInput); if (Number.isInteger(n) && n >= 1 && n <= workspace.pages.length) p.goToPageIndex(n - 1); else p.setPageNumInput(String(index + 1)); };
  return <div className="pdfe-screen-enter" data-screen-label="편집기" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    <header className="pdfe-editor-header" style={{ position: 'relative', display: 'flex', alignItems: 'center', borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
      <button className="pdfe-brand" onClick={p.goToUpload} style={{ background: 'var(--pdfe-button-bg, transparent)', border: 0, height: 32, borderRadius: 9999, fontSize: 17, fontWeight: 500, letterSpacing: '-.025em', color: TEXT, flexShrink: 0 }}>PDF 편집</button>
      <div className="pdfe-filename" style={{ minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 8 }}>
        <FileText size={22} strokeWidth={1.5} />
        <input aria-label="파일명" title={workspace.fileName} disabled={p.isExporting} value={workspace.fileName} onChange={e => p.onFileNameChange(e.target.value)} style={{ width: 220, minWidth: 0, maxWidth: '100%', height: 32, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '6px 12px', background: SURFACE, color: TEXT, fontSize: 14, fontWeight: 500, textOverflow: 'ellipsis' }} />
      </div>
      <button onClick={p.onRetrySave} disabled={p.saveStatus !== 'error'} style={{ border: 0, borderRadius: 9999, height: 32, background: 'var(--pdfe-button-bg, transparent)', color: p.saveStatus === 'error' ? DANGER : TEXT_SUBTLE, fontSize: 13 }}>{p.hasUnappliedEdit ? '적용되지 않은 편집' : saveLabels[p.saveStatus]}</button>
      <button className="pdfe-primary-button" disabled={p.isExporting} onClick={p.goExport} style={solidAccentBtn({ height: 32, borderRadius: 9999, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 })}><Download size={22} strokeWidth={1.5} />내보내기</button>
    </header>
    <div style={{ minHeight: TOOLBAR_H, flex: '0 0 auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 20px', borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
      <button style={toolBase} aria-label="전체 페이지 보기" title="전체 페이지 보기" onClick={() => void guarded(p.onOpenGridView)}><LayoutGrid size={22} strokeWidth={1.5} /></button>
      <div className="pdfe-segmented" role="group" aria-label="편집 도구">
        {(Object.keys(labels) as Tool[]).map(tool => {
          const Icon = toolIcons[tool];
          return <button key={tool} aria-label={labels[tool]} aria-pressed={p.activeTool === tool} title={labels[tool]} disabled={p.isExporting} style={{ ...(p.activeTool === tool ? toolActive : toolBase), flex: 1 }} onClick={() => void guarded(() => p.setActiveTool(tool))}>
            <Icon size={22} strokeWidth={1.5} />
          </button>;
        })}
      </div>
      {p.activeTool === 'select' && <button aria-pressed={multiSelect} disabled={!editable} style={{ ...(multiSelect ? toolActive : toolBase), width: 'auto', padding: '0 12px', border: `1px solid ${multiSelect ? TEXT : BORDER}` }} onClick={() => setMultiSelect(value => !value)}>여러 줄 선택</button>}
      <div style={{ flex: 1 }} /><button style={toolBase} disabled={!p.canUndo || p.isExporting} onClick={() => undo(false)} aria-label="실행 취소" title="실행 취소"><Undo2 size={22} strokeWidth={1.5} /></button><button style={toolBase} disabled={!p.canRedo || p.isExporting} onClick={() => undo(true)} aria-label="다시 실행" title="다시 실행"><Redo2 size={22} strokeWidth={1.5} /></button>
    </div>
    {p.activeTool === 'select' && sourceSelections.length > 0 && <div className="pdfe-selection-row" style={{ display: 'flex', alignItems: 'center', padding: '6px 20px', borderBottom: `1px solid ${BORDER}`, background: SURFACE, gap: 8 }}>
      <span role="status" aria-live="polite">{sourceSelections.length}개 선택</span>
      {sourceSelections.length >= 2 && <button style={{ borderRadius: 9999 }} disabled={!editable || sourceSelections.some(target => !target.editable)} onClick={() => void groupSelection()}>묶어서 편집</button>}
      {selection && engine.info?.canCopy && <button title="텍스트 복사" onClick={() => void copy()}>복사</button>}
    </div>}
    {engine.info?.hasSignatures && <div role="note" style={{ padding: '6px 18px', fontSize: 12 }}>수정한 PDF는 기존 인증서 서명이 유효하지 않을 수 있습니다. 복제본은 원본 태그 구조의 의미를 유지하지 않습니다.</div>}
    <div className="pdfe-editor-workspace" style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }}>
      <aside style={{ width: railOpen ? 176 : 32, flexShrink: 0, borderRight: `1px solid ${BORDER}`, background: SURFACE, display: 'flex', flexDirection: 'column' }}>
        <button aria-label={railOpen ? '페이지 목록 접기' : '페이지 목록 펼치기'} onClick={() => setRailOpen(!railOpen)} style={{ flexShrink: 0, border: 0, background: 'var(--pdfe-button-bg, transparent)', padding: '12px 4px', color: 'var(--pdfe-button-color, var(--pdfe-text-subtle))', fontSize: 13, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 4 }}>{railOpen && `페이지 (${workspace.pages.length})`}{railOpen ? <ChevronLeft size={22} strokeWidth={1.5} /> : <ChevronRight size={22} strokeWidth={1.5} />}</button>
        {railOpen && <div className="pdfe-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
          {workspace.pages.map((item, i) => {
            const capability = item.kind === 'pdf' ? engine.info?.pages[item.sourcePageIndex]?.duplicate : undefined;
            return <div key={item.id} className="pdfe-page-card" data-selected={item.id === page.id} draggable={assemble} onDragStart={() => { draggingThumb.current = item.id; }} onDragOver={e => { if (assemble) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (assemble && draggingThumb.current) p.onReorderPages(draggingThumb.current, item.id); draggingThumb.current = null; }} style={{ marginBottom: 14 }}>
              <div style={{ height: RAIL_CARD_H, padding: 8, position: 'relative', background: '#fff', borderRadius: 10, border: `${item.id === page.id ? 2 : 1}px solid ${item.id === page.id ? ACCENT : BORDER}` }}>
                <PageThumbnail page={item} engine={engine} revision={p.revision} />
                <button className="pdfe-thumb-hit" aria-label={`${i + 1} 페이지 열기`} onClick={() => p.onThumbClick(item.id)} />
                <div className="pdfe-page-controls"><button disabled={!assemble || capability?.allowed === false} title={capability?.allowed === false ? capability.reason : '복제'} onClick={() => p.onDuplicatePage(item.id)}>복제</button><button disabled={!assemble} onClick={() => p.onRotatePage(item.id, 90)}>회전</button><button disabled={!assemble || workspace.pages.length === 1} onClick={() => p.onDeletePage(item.id)}>삭제</button></div>
              </div><div style={{ textAlign: 'center', fontSize: 12, marginTop: 5 }}>{i + 1}</div>
            </div>;
          })}<button disabled={!assemble} onClick={p.onAddPage} style={{ width: '100%', border: `1px solid ${BORDER_STRONG}`, borderRadius: 9999, padding: '6px 12px', background: 'var(--pdfe-button-bg, var(--pdfe-surface))', color: 'var(--pdfe-button-color, var(--pdfe-text-subtle))', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}><Plus size={22} strokeWidth={1.5} />페이지 추가</button>
        </div>}
      </aside>
      <div ref={scrollRef} className="pdfe-scroll" style={{ flex: 1, minWidth: 0, overflow: 'auto', background: CANVAS_BG, padding: '40px 30px 90px' }}>
        {renderError && <div role="alert">{renderError} <button onClick={() => void engine.retry().catch(e => p.showToast(String(e)))}>다시 시도</button></div>}
        <div style={{ width: 'max-content', margin: '0 auto' }}>{render ? <PdfPageSurface page={page} render={render} zoom={p.zoom} tool={p.activeTool} disabled={!editable || !!edit} scrollRef={scrollRef} selectedIds={sourceSelections.flatMap(target => target.lineIds)} multiSelect={multiSelect} onSelect={(target, additive) => void choose(target, false, additive)} onEdit={target => { if (sourceSelections.length <= 1) void choose(target, true); }} onClearSelection={() => { if (!p.isExporting && !edit) clearSelection(); }} /> : <div role="status">페이지를 여는 중…</div>}</div>
      </div>
      {edit && <TextEditPanel key={`${page.id}:${JSON.stringify(edit.target.lineIds)}:${edit.revision}`} page={page} target={edit.target} sourceFonts={edit.fonts} fontAssets={workspace.fontAssets} downloadFont={engine.downloadFont} requiresCommit={edit.requiresCommit} baseRevision={edit.revision} validate={engine.validate} getRevision={() => p.getDocumentState().revision} onCommit={commit} onCancel={cancel} onPreview={preview} onDirtyChange={dirty} registerController={registerPanel} showToast={p.showToast} disabled={p.isExporting} />}
    </div>
    <nav className="pdfe-bottom-nav" style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 24, boxShadow: PANEL_SHADOW, display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', zIndex: 30 }}>
      <button aria-label="이전 페이지" disabled={index === 0 || p.isExporting} onClick={() => p.goToPageIndex(index - 1)}><ChevronLeft size={22} strokeWidth={1.5} /></button><input aria-label="현재 페이지" value={p.pageNumInput} onChange={e => p.setPageNumInput(e.target.value)} onBlur={commitPageNumber} onKeyDown={e => { if (e.key === 'Enter') commitPageNumber(); }} style={{ width: 36, textAlign: 'center' }} /><span>/ {workspace.pages.length}</span><button aria-label="다음 페이지" disabled={index === workspace.pages.length - 1 || p.isExporting} onClick={() => p.goToPageIndex(index + 1)}><ChevronRight size={22} strokeWidth={1.5} /></button>
      <button aria-label="축소" onClick={() => p.setZoom(Math.max(.25, p.zoom - .25))}><Minus size={22} strokeWidth={1.5} /></button><span>{Math.round(p.zoom * 100)}%</span><button aria-label="확대" onClick={() => p.setZoom(Math.min(4, p.zoom + .25))}><Plus size={22} strokeWidth={1.5} /></button>
      <button aria-label="폭 맞춤" title="폭 맞춤" onClick={() => { if (render && scrollRef.current) p.setZoom((scrollRef.current.clientWidth - 60) / ((render.displayBounds[2] - render.displayBounds[0]) * 96 / 72)); }}><ArrowLeftRight size={22} strokeWidth={1.5} /></button>
    </nav>
  </div>;
}

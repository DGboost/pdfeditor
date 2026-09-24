import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeftRight, BookOpen, ChevronLeft, ChevronRight, Hand, LayoutGrid, Minus, MousePointer2, Plus, Redo2, Undo2 } from 'lucide-react';
import type { DocumentState, DownloadedFontAsset, EditController, Page, TextContent, Tool, Workspace } from '../../../types/pdfEditor';
import type { DocumentActions } from '../../../hooks/useDocumentReducer';
import type { PdfDocumentController } from '../../../hooks/usePdfDocument';
import type { EditableTextTarget, RenderedPage, SourceFontInfo, SourceTextLine } from '../../../pdf/engineTypes';
import type { SaveStatus } from '../../../utils/db';
import { plainText } from '../../../pdf/textEditing';
import { buildSourceTextGroup } from '../../../pdf/sourceTextGroups';
import { ACCENT, BORDER, BORDER_STRONG, PANEL_SHADOW, SURFACE, TEXT, TEXT_SUBTLE, CANVAS_BG, TOOLBAR_H, RAIL_CARD_H, toolBase, toolActive } from '../../../styles/theme';
import { PdfPageSurface } from './PdfPageSurface';
import { PageThumbnail } from './GridView';
import { TextEditPanel } from './TextEditPanel';
import { DocumentHeader } from '../../editor/DocumentHeader';

export interface EditorScreenProps {
  workspace: Workspace; revision: number; engine: PdfDocumentController; docActions: DocumentActions;
  getDocumentState: () => DocumentState; canUndo: boolean; canRedo: boolean;
  pageNumInput: string; setPageNumInput: (s: string) => void; goToPageIndex: (i: number) => void;
  zoom: number; setZoom: (z: number) => void; isExporting: boolean; showToast: (s: string) => void;
  goToUpload: () => void; goExport: () => void; onOpenGridView: () => void;
  onDuplicatePage: (id: string) => void; onRotatePage: (id: string, delta: number) => void; onDeletePage: (id: string) => void;
  onAddPage: () => void; onReorderPages: (from: string, to: string) => void; onThumbClick: (id: string) => void;
  activeTool: Tool; setActiveTool: (t: Tool) => void;
  onFileNameChange: (s: string) => void; saveStatus: SaveStatus; saveError: string | null; onRetrySave: () => void;
  hasUnappliedEdit: boolean; onUnappliedEditChange: (v: boolean) => void;
  registerEditController: (c: EditController | null) => void;
}
interface EditSelection { id: number; pageId: string; target: EditableTextTarget; original?: SourceTextLine; fonts?: SourceFontInfo[]; revision: number }
const labels: Record<Tool, string> = { pan: '손 도구', select: '선택' };
const toolIcons = { pan: Hand, select: MousePointer2 };
const saveLabels: Record<SaveStatus, string> = { dirty: '저장되지 않은 변경', saving: '저장 중…', saved: '자동 저장됨', error: '저장 실패 · 다시 시도' };
export function EditorScreen(p: EditorScreenProps) {
  const { workspace, engine, docActions } = p;
  const page = workspace.pages.find(item => item.id === workspace.activePageId)!;
  const index = workspace.pages.indexOf(page);
  const [railOpen, setRailOpen] = useState(true);
  const [twoPage, setTwoPage] = useState(false);
  const spreadStart = twoPage && index > 0 ? index - (index - 1) % 2 : index;
  const visiblePages = useMemo(() => workspace.pages.slice(spreadStart, spreadStart + (twoPage && spreadStart > 0 ? 2 : 1)), [workspace.pages, spreadStart, twoPage]);
  const [renders, setRenders] = useState<Record<string, { owner: string; key: string; render?: RenderedPage; error?: { message: string; candidateRevision?: number } }>>({});
  const [panelWidth, setPanelWidth] = useState(380);
  const [selection, setSelection] = useState<EditableTextTarget | null>(null);
  const [sourceSelections, setSourceSelections] = useState<Extract<EditableTextTarget, { kind: 'source' }>[]>([]);
  const [multiSelect, setMultiSelect] = useState(false);
  const [edit, setEdit] = useState<EditSelection | null>(null);
  const [candidate, setCandidate] = useState<{ page: Page; revision: number } | null>(null);
  const [dpr, setDpr] = useState(window.devicePixelRatio || 1);
  const renderOwner = `${workspace.id}:${engine.sessionId}`;
  const renderGeneration = `${renderOwner}:${p.revision}:${p.zoom}:${dpr}`;
  const controller = useRef<EditController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const resizeDrag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const selectionPage = useRef(page.id);
  const selectedSources = useRef(sourceSelections);
  const selectionQueue = useRef<Promise<void>>(Promise.resolve());
  const selectionEpoch = useRef(0);
  const draggingThumb = useRef<string | null>(null);
  const selectionToken = useRef(0);
  const editable = !!engine.info?.canEdit && !p.isExporting;
  const assemble = !!engine.info?.canAssemble && !p.isExporting;
  const latest = useRef(p); latest.current = p;
  const cancel = useCallback(() => { selectionToken.current++; const active = controller.current; controller.current = null; active?.cancel(); setEdit(null); setCandidate(null); latest.current.onUnappliedEditChange(false); }, []);
  const clearSelection = useCallback(() => { selectionEpoch.current++; cancel(); selectedSources.current = []; setSelection(null); setSourceSelections([]); }, [cancel]);
  const flush = useCallback(async () => controller.current ? controller.current.flush() : true, []);
  useEffect(() => {
    p.registerEditController({ flush, cancel });
    return () => { selectionEpoch.current++; p.registerEditController(null); };
  }, [p.registerEditController, flush, cancel]);
  const registerPanel = useCallback((c: EditController | null) => { controller.current = c; }, []);
  const preview = useCallback((next: Page | null, revision: number) => setCandidate(next ? { page: next, revision } : null), []);
  const dirty = useCallback((value: boolean) => latest.current.onUnappliedEditChange(value), []);
  useEffect(() => { clearSelection(); selectionPage.current = page.id; }, [workspace.id, clearSelection]);
  useEffect(() => {
    if (selectionPage.current !== page.id) { clearSelection(); selectionPage.current = page.id; }
  }, [page.id, clearSelection]);
  useEffect(() => { clearSelection(); setMultiSelect(false); }, [p.activeTool, clearSelection]);
  useEffect(() => { clearSelection(); setRenders({}); }, [engine.sessionId, clearSelection]);
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
    // Retain page geometry during previews so the viewer does not clamp its scroll position.
    setRenders(previous => Object.fromEntries(visiblePages.map(item => {
      const prior = previous[item.id];
      return [item.id, prior?.owner === renderOwner ? { ...prior, error: undefined } : { owner: renderOwner, key: '' }];
    })));
    for (const item of visiblePages) {
      const draft = candidate?.page.id === item.id ? candidate : null;
      const key = `${renderGeneration}:${draft?.revision || 0}`;
      void engine.render(draft?.page || item, 96 / 72 * p.zoom * dpr, p.revision, draft?.revision || 0, 'active').then(result => {
        if (current) setRenders(previous => ({ ...previous, [item.id]: { owner: renderOwner, key, render: result } }));
      }).catch(error => {
        if (current) setRenders(previous => ({ ...previous, [item.id]: { ...previous[item.id], owner: renderOwner, key: '', error: { message: error instanceof Error ? error.message : '페이지 표시 실패', candidateRevision: draft?.revision } } }));
      });
    }
    return () => { current = false; };
  }, [visiblePages, candidate, p.revision, p.zoom, dpr, engine.render, renderOwner, renderGeneration]);
  const guarded = async (action: () => void) => { if (!p.isExporting && await flush()) action(); };
  const undo = useCallback((redo: boolean) => { if (latest.current.isExporting) return; clearSelection(); if (redo) latest.current.docActions.redo(); else latest.current.docActions.undo(); }, [clearSelection]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && !latest.current.isExporting) { clearSelection(); return; }
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || event.isComposing) return;
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
      event.preventDefault(); undo(event.shiftKey);
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [undo, clearSelection]);
  const choose = (pageId: string, targets: readonly EditableTextTarget[], mode: 'replace' | 'toggle' | 'add') => {
    if (!targets.length && mode !== 'replace') return;
    const requestedSession = engine.sessionId;
    const requestedWorkspace = workspace.id;
    const epoch = selectionEpoch.current;
    selectionQueue.current = selectionQueue.current.then(async () => {
      // Let React mount the preceding selection's controller before the next gesture flushes it.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (epoch !== selectionEpoch.current || latest.current.isExporting || latest.current.engine.sessionId !== requestedSession || latest.current.workspace.id !== requestedWorkspace) return;
      const previous = selectionPage.current === pageId ? selectedSources.current : [];
      if (!await flush()) return;
      if (epoch !== selectionEpoch.current || latest.current.isExporting || latest.current.engine.sessionId !== requestedSession || latest.current.workspace.id !== requestedWorkspace) return;
      selectionPage.current = pageId;
      latest.current.docActions.setActivePage(pageId);
      const token = ++selectionToken.current;
      const state = latest.current.getDocumentState();
      const currentPage = state.workspace?.pages.find(item => item.id === pageId);
      if (!currentPage) return;
      if (!targets.length) {
        selectedSources.current = [];
        setSourceSelections([]);
        setSelection(null);
        return;
      }
      if (currentPage.kind !== 'pdf') return;
      try {
        const source = await engine.text(currentPage.sourcePageIndex);
        if (token !== selectionToken.current || latest.current.getDocumentState().revision !== state.revision || latest.current.engine.sessionId !== requestedSession) return;
        const resolvedLines = new Map<string, { target: Extract<EditableTextTarget, { kind: 'source' }>; original?: SourceTextLine }>();
        const resolve = (id: string): { target: Extract<EditableTextTarget, { kind: 'source' }>; original?: SourceTextLine } => {
          const cached = resolvedLines.get(id);
          if (cached) return cached;
          const sourceEdit = currentPage.textEdits.find(item => item.lineIds.includes(id));
          const lineIds = sourceEdit?.lineIds ?? [id];
          const original = source.lines.find(line => line.lineId === lineIds[0]);
          if (!original) throw new Error('선택한 원본 줄을 찾을 수 없습니다.');
          let resolved: { target: Extract<EditableTextTarget, { kind: 'source' }>; original?: SourceTextLine };
          if (lineIds.length > 1) {
            const group = buildSourceTextGroup(currentPage, source, lineIds);
            resolved = { target: { kind: 'source', ...group, content: sourceEdit?.content ?? group.content, widthPt: sourceEdit?.widthPt ?? group.widthPt, layout: sourceEdit?.layout ?? group.layout, editable: true } };
          } else {
            resolved = { original, target: { kind: 'source', lineIds, bounds: original.bounds, quads: original.chars.map(char => char.quad), content: sourceEdit?.content || original.content, widthPt: sourceEdit?.widthPt ?? original.widthPt, editable: original.editable, reason: original.reason } };
          }
          for (const lineId of lineIds) resolvedLines.set(lineId, resolved);
          return resolved;
        };
        const resolveTargets = (items: readonly EditableTextTarget[]) => {
          const resolved = new Set<Extract<EditableTextTarget, { kind: 'source' }>>();
          for (const item of items) for (const id of item.lineIds) resolved.add(resolve(id).target);
          return [...resolved];
        };
        const incoming = resolveTargets(targets);
        const prior = mode === 'replace' ? [] : resolveTargets(previous);
        const next = mode === 'replace' ? incoming
          : [...(mode === 'toggle' ? prior.filter(item => !incoming.includes(item)) : prior), ...incoming.filter(item => !prior.includes(item))];
        selectedSources.current = next;
        setSourceSelections(next);
        setSelection(null);
        if (!next.length) return;
        const ids = [...new Set(next.flatMap(item => item.lineIds))];
        const single = next.length === 1 ? resolve(next[0].lineIds[0]) : null;
        const combined: EditableTextTarget = single?.target ?? { kind: 'source', ...buildSourceTextGroup(currentPage, source, ids), editable: true };
        setSelection(combined);
        if (!latest.current.engine.info?.canEdit || !combined.editable) { latest.current.showToast(combined.reason || '이 문서는 본문 편집 권한이 없습니다.'); return; }
        setEdit({ id: token, pageId, target: combined, original: single?.original, fonts: source.fonts, revision: state.revision });
      } catch (error) { latest.current.showToast(error instanceof Error ? error.message : '텍스트를 열 수 없습니다.'); }
    });
  };
  const commit = (content: TextContent, widthPt: number, fontAssets: DownloadedFontAsset[] = []) => {
    if (!edit || !engine.info?.canEdit || p.getDocumentState().revision !== edit.revision) return;
    const target = edit.target;
    const original = edit.original;
    if (target.lineIds.length === 1 && original && original.widthPt === widthPt && JSON.stringify(original.content) === JSON.stringify(content)) docActions.removeTextEdit(edit.pageId, target.lineIds[0]);
    else docActions.upsertTextEdit(edit.pageId, { lineIds: target.lineIds, layout: target.layout, content, widthPt }, fontAssets);
    const committedTarget = { ...target, content, widthPt };
    setSelection(committedTarget);
    setSourceSelections([committedTarget]);
    selectedSources.current = [committedTarget];
    setEdit(null); setCandidate(null); p.onUnappliedEditChange(false);
  };
  const mergeSelectedText = async () => {
    const lineIds = [...new Set(selectedSources.current.flatMap(target => target.lineIds))];
    if (lineIds.length < 2 || !selection || selection.kind !== 'source') return;
    const pageId = selectionPage.current;
    const workspaceId = latest.current.workspace.id;
    const sessionId = latest.current.engine.sessionId;
    const epoch = selectionEpoch.current;
    const stillCurrent = (revision?: number) => {
      const state = latest.current.getDocumentState();
      const selectedIds = new Set(selectedSources.current.flatMap(target => target.lineIds));
      return selectionPage.current === pageId && selectionEpoch.current === epoch
        && latest.current.workspace.id === workspaceId && latest.current.engine.sessionId === sessionId
        && state.workspace?.activePageId === pageId && !latest.current.isExporting
        && selectedIds.size === lineIds.length && lineIds.every(id => selectedIds.has(id))
        && (revision === undefined || state.revision === revision);
    };
    if (!await flush() || !stillCurrent()) return;
    const state = latest.current.getDocumentState();
    const page = state.workspace?.pages.find(item => item.id === pageId);
    if (page?.kind !== 'pdf') return;
    try {
      const source = await latest.current.engine.text(page.sourcePageIndex);
      if (!stillCurrent(state.revision)) return;
      const group = buildSourceTextGroup(page, source, lineIds);
      const groupedEdit = { lineIds: group.lineIds, content: group.content, widthPt: group.widthPt, layout: group.layout };
      const members = new Set(group.lineIds);
      const candidate = { ...page, textEdits: [...page.textEdits.filter(item => !item.lineIds.some(id => members.has(id))), groupedEdit] };
      const result = await latest.current.engine.validate(candidate, state.revision, state.revision + 1);
      if (!stillCurrent(state.revision)) return;
      if (!result.ok) { latest.current.showToast(result.message); return; }
      latest.current.docActions.upsertTextEdit(pageId, groupedEdit);
      const merged: Extract<EditableTextTarget, { kind: 'source' }> = { kind: 'source', ...group, editable: true };
      selectedSources.current = [merged];
      setSelection(merged);
      setSourceSelections([merged]);
      setEdit(null);
      setCandidate(null);
      latest.current.onUnappliedEditChange(false);
      latest.current.showToast('선택한 텍스트를 하나의 객체로 묶었습니다.');
    } catch (error) {
      if (stillCurrent()) latest.current.showToast(error instanceof Error ? error.message : '텍스트를 묶을 수 없습니다.');
    }
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
  const panelBounds = useCallback(() => {
    const width = layoutRef.current?.clientWidth ?? 0;
    const max = window.matchMedia('(max-width: 640px)').matches ? Math.max(0, width - 12) : Math.max(0, width - (railRef.current?.offsetWidth ?? 0) - 240 - 12);
    return { min: Math.min(280, max), max };
  }, []);
  const resizePanel = useCallback((width: number) => {
    const bounds = panelBounds();
    setPanelWidth(Math.round(Math.max(bounds.min, Math.min(bounds.max, width))));
  }, [panelBounds]);
  useEffect(() => {
    const element = layoutRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setPanelWidth(width => {
      const bounds = panelBounds();
      return Math.round(Math.max(bounds.min, Math.min(bounds.max, width)));
    }));
    observer.observe(element);
    if (railRef.current) observer.observe(railRef.current);
    return () => observer.disconnect();
  }, [panelBounds]);
  return <div className="pdfe-screen-enter" data-screen-label="편집기" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    <DocumentHeader fileName={workspace.fileName} busy={p.isExporting} format="pdf" onFileNameChange={p.onFileNameChange}
      onHome={p.goToUpload} onExport={p.goExport} saveLabel={p.hasUnappliedEdit ? '적용되지 않은 편집' : saveLabels[p.saveStatus]}
      saveError={p.saveError} onRetrySave={p.onRetrySave} />
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
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {p.activeTool === 'select' && sourceSelections.length > 0 && <div className="pdfe-selection-row" style={{ display: 'flex', alignItems: 'center', flexWrap: 'nowrap', gap: 8 }}>
          <span role="status" aria-live="polite">{sourceSelections.length}개 선택</span>
          {sourceSelections.length > 1 && selection?.kind === 'source' && selection.lineIds.length > 1 && <button type="button" aria-label="선택한 텍스트를 한 객체로 묶기" title={p.hasUnappliedEdit ? '현재 편집 내용을 먼저 적용해 주세요.' : '선택한 텍스트를 한 객체로 묶습니다.'} disabled={!editable || !selection.editable || p.hasUnappliedEdit} onClick={() => void mergeSelectedText()}>하나의 객체로 묶기</button>}
          {selection && engine.info?.canCopy && <button title="텍스트 복사" onClick={() => void copy()}>복사</button>}
        </div>}
        <button style={toolBase} disabled={!p.canUndo || p.isExporting} onClick={() => undo(false)} aria-label="실행 취소" title="실행 취소"><Undo2 size={22} strokeWidth={1.5} /></button><button style={toolBase} disabled={!p.canRedo || p.isExporting} onClick={() => undo(true)} aria-label="다시 실행" title="다시 실행"><Redo2 size={22} strokeWidth={1.5} /></button>
      </div>
    </div>
    {visiblePages.map((item, offset) => {
      const error = renders[item.id]?.owner === renderOwner ? renders[item.id].error : undefined;
      return error && error.candidateRevision === undefined && <div key={item.id} role="alert" style={{ padding: '6px 20px', background: SURFACE }}>
        {spreadStart + offset + 1} 페이지: {error.message} <button onClick={() => void engine.retry().catch(e => p.showToast(String(e)))}>다시 시도</button>
      </div>;
    })}
    {engine.info?.hasSignatures && <div role="note" style={{ padding: '6px 18px', fontSize: 12 }}>수정한 PDF는 기존 인증서 서명이 유효하지 않을 수 있습니다. 복제본은 원본 태그 구조의 의미를 유지하지 않습니다.</div>}
    <div ref={layoutRef} className="pdfe-editor-workspace" style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0, '--pdfe-edit-panel-width': `${panelWidth}px` } as CSSProperties}>
      <aside ref={railRef} style={{ width: railOpen ? 176 : 32, flexShrink: 0, borderRight: `1px solid ${BORDER}`, background: SURFACE, display: 'flex', flexDirection: 'column' }}>
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
        <div style={{ width: 'max-content', margin: '0 auto', display: 'flex', alignItems: 'flex-start', gap: 24 }}>
          {visiblePages.map((item, offset) => {
            const result = renders[item.id]?.owner === renderOwner ? renders[item.id] : undefined;
            const fresh = result?.key === `${renderGeneration}:${candidate?.page.id === item.id ? candidate.revision : 0}`;
            return <section key={item.id} aria-label={`${spreadStart + offset + 1} 페이지`} style={{ flex: '0 0 auto' }}>
              <div style={{ textAlign: 'center', color: TEXT_SUBTLE, marginBottom: 8 }}>{spreadStart + offset + 1}</div>
              {result?.render
                ? <PdfPageSurface page={item} render={result.render} zoom={p.zoom} tool={p.activeTool} disabled={p.isExporting || !fresh} scrollRef={scrollRef} selectedIds={selectionPage.current === item.id ? sourceSelections.flatMap(target => target.lineIds) : []} multiSelect={multiSelect} onSelect={(target, additive) => choose(item.id, [target], additive ? 'toggle' : 'replace')} onSelectMany={(targets, additive) => choose(item.id, targets, additive ? 'add' : 'replace')} onClearSelection={() => { if (!p.isExporting && !edit) clearSelection(); }} />
                : !result?.error && <div role="status">페이지를 여는 중…</div>}
            </section>;
          })}
        </div>
      </div>
      {edit && <>
        <div className="pdfe-edit-panel-resizer" role="separator" aria-label="편집 패널 너비" aria-orientation="vertical" aria-valuemin={panelBounds().min} aria-valuemax={panelBounds().max} aria-valuenow={panelWidth} tabIndex={0}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            resizeDrag.current = { pointerId: event.pointerId, x: event.clientX, width: panelWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            const drag = resizeDrag.current;
            if (drag?.pointerId === event.pointerId) resizePanel(drag.width + drag.x - event.clientX);
          }}
          onPointerUp={event => { if (resizeDrag.current?.pointerId === event.pointerId) { resizeDrag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
          onPointerCancel={event => { if (resizeDrag.current?.pointerId === event.pointerId) { resizeDrag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }}
          onLostPointerCapture={() => { resizeDrag.current = null; }}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const bounds = panelBounds();
            resizePanel(event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : panelWidth + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 50 : 10));
          }} />
        <TextEditPanel key={edit.id} page={workspace.pages.find(item => item.id === edit.pageId)!} target={edit.target} sourceFonts={edit.fonts} fontAssets={workspace.fontAssets} downloadFont={engine.downloadFont} baseRevision={edit.revision} validate={engine.validate} getRevision={() => p.getDocumentState().revision} onCommit={commit} onCancel={cancel} onPreview={preview} previewError={renders[edit.pageId]?.owner === renderOwner ? renders[edit.pageId].error : undefined} onDirtyChange={dirty} registerController={registerPanel} showToast={p.showToast} disabled={p.isExporting} />
      </>}
    </div>
    <nav className="pdfe-bottom-nav" style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 24, boxShadow: PANEL_SHADOW, display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', zIndex: 30 }}>
      <button aria-label="두 페이지 보기" title="두 페이지 보기" aria-pressed={twoPage} disabled={p.isExporting} style={twoPage ? toolActive : toolBase} onClick={() => void guarded(() => setTwoPage(value => !value))}><BookOpen size={22} strokeWidth={1.5} /></button>
      <button aria-label="이전 페이지" disabled={spreadStart === 0 || p.isExporting} onClick={() => p.goToPageIndex(twoPage ? Math.max(0, spreadStart - 2) : index - 1)}><ChevronLeft size={22} strokeWidth={1.5} /></button><input aria-label="현재 페이지" value={p.pageNumInput} onChange={e => p.setPageNumInput(e.target.value)} onBlur={commitPageNumber} onKeyDown={e => { if (e.key === 'Enter') commitPageNumber(); }} style={{ width: 36, textAlign: 'center' }} /><span>/ {workspace.pages.length}</span><button aria-label="다음 페이지" disabled={spreadStart + visiblePages.length >= workspace.pages.length || p.isExporting} onClick={() => p.goToPageIndex(spreadStart + visiblePages.length)}><ChevronRight size={22} strokeWidth={1.5} /></button>
      <button aria-label="축소" disabled={p.zoom <= .25} onClick={() => p.setZoom(Math.max(25, Math.round(p.zoom * 100) - 5) / 100)}><Minus size={22} strokeWidth={1.5} /></button><span>{Math.round(p.zoom * 100)}%</span><button aria-label="확대" disabled={p.zoom >= 4} onClick={() => p.setZoom(Math.min(400, Math.round(p.zoom * 100) + 5) / 100)}><Plus size={22} strokeWidth={1.5} /></button>
      <button aria-label="폭 맞춤" title="폭 맞춤" onClick={() => {
        const displayed = visiblePages.map(item => renders[item.id]?.render);
        if (scrollRef.current && displayed.every((result): result is RenderedPage => !!result)) {
          const width = displayed.reduce((total, result) => total + (result.displayBounds[2] - result.displayBounds[0]) * 96 / 72, 0);
          const availableWidth = scrollRef.current.clientWidth - 60 - (displayed.length - 1) * 24;
          if (availableWidth > 0) p.setZoom(availableWidth / width);
        }
      }}><ArrowLeftRight size={22} strokeWidth={1.5} /></button>
    </nav>
  </div>;
}

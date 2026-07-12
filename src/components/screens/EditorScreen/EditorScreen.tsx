import { useRef, useState, useCallback } from 'react';
import type { RefObject } from 'react';
import type { ChangeEvent, MouseEvent as ReactMouseEvent, KeyboardEvent } from 'react';
import type { Page, Signatures, Tool, SigModalTarget, DragKind } from '../../../types/pdfEditor';
import type { EditableBlockField } from '../../../hooks/useDocumentReducer';
import { ACCENT, BORDER, CANVAS_BG, PAGE_SHADOW, TOOLBAR_H, FORMAT_H, RAIL_CARD_H, RAIL_GAP, TOOL_BTN, FONT_STACK, solidAccentBtn, outlineAccentBtn, spinnerAccentStyle } from '../../../styles/theme';
import { useCanvasPointerInteractions } from '../../../hooks/useCanvasPointerInteractions';
import { useSelectionPreserve } from '../../../hooks/useSelectionPreserve';

export interface EditorDocActions {
  patchPage: (pageId: string, patch: Partial<Page>) => void;
  replacePage: (pageId: string, page: Page) => void;
  addImage: (pageId: string, id: string, x: number, y: number) => void;
  deleteImage: (pageId: string, id: string) => void;
  addSigField: (pageId: string, id: string, x: number, y: number) => void;
  deleteSigField: (pageId: string, id: string) => void;
  saveSignature: (target: SigModalTarget, dataUrl: string) => void;
  addTextBox: (pageId: string, id: string, x: number, y: number) => void;
  deleteTextBox: (pageId: string, id: string) => void;
  addShape: (pageId: string, id: string, x: number, y: number) => void;
  deleteShape: (pageId: string, id: string) => void;
  moveItem: (pageId: string, kind: DragKind, id: string, dx: number, dy: number) => void;
  duplicatePage: (id: string, newId: string) => void;
  rotatePage: (id: string, delta: number) => void;
  deletePage: (id: string) => void;
  addPage: (id: string) => void;
  reorderPages: (fromId: string, toId: string) => void;
  applyGlobalFont: (family: string, size: number) => void;
  resetGlobalFont: () => void;
  updateTextItem: (pageId: string, itemId: string, html: string) => void;
  updateBlock: (pageId: string, blockId: string, field: EditableBlockField, html: string) => void;
  updateTextBoxText: (pageId: string, id: string, html: string) => void;
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
}

export interface EditorScreenProps {
  fileName: string;
  onFileNameChange: (name: string) => void;
  pages: Page[];
  signatures: Signatures;
  globalFontFamily: string | null;
  globalFontSize: number | null;
  docActions: EditorDocActions;
  canUndo: boolean;
  canRedo: boolean;
  activePageId: string;
  setActivePageId: (id: string) => void;
  pageNumInput: string;
  setPageNumInput: (s: string) => void;
  goToPageIndex: (idx: number) => void;
  zoom: number;
  setZoom: (z: number) => void;
  pageWrapRef: RefObject<HTMLDivElement | null>;
  ensurePageProcessed: (page: Page | undefined) => Promise<void>;
  isExporting: boolean;
  showToast: (msg: string) => void;
  goToUpload: () => void;
  goExport: () => void;
  onOpenGridView: () => void;
  onDuplicatePage: (id: string) => void;
  onRotatePage: (id: string, delta: number) => void;
  onDeletePage: (id: string) => void;
  onAddPage: () => void;
  onReorderPages: (fromId: string, toId: string) => void;
  onThumbClick: (id: string) => void;
  onOpenSigModal: (target: SigModalTarget) => void;
  activeTool: Tool;
  setActiveTool: (t: Tool) => void;
}

const FONT_FAMILY_OPTIONS = [
  { value: "'Pretendard',sans-serif", label: 'Pretendard' },
  { value: "'Noto Sans KR',sans-serif", label: 'Noto Sans KR' },
  { value: "'Noto Serif KR',serif", label: 'Noto Serif KR' },
  { value: "'Nanum Gothic',sans-serif", label: 'Nanum Gothic' },
  { value: "'Nanum Myeongjo',serif", label: 'Nanum Myeongjo' },
  { value: 'Georgia,serif', label: 'Georgia' },
  { value: "'Courier New',monospace", label: 'Courier New' },
  { value: "'Times New Roman','Liberation Serif',serif", label: 'Times New Roman' },
  { value: "Arial,'Liberation Sans',sans-serif", label: 'Arial' },
  { value: "'Palatino Linotype','Book Antiqua',Palatino,serif", label: 'Palatino Linotype' },
  { value: "'FreeMono','Courier New',monospace", label: 'Free Mono' },
  { value: "'Source Han Serif KR','Noto Serif KR',serif", label: 'Source Han Serif KR' },
];

const COLOR_SWATCHES = ['#1f2937', '#c0392b', '#1f7a4c', '#b8860b'];
const HIGHLIGHT_SWATCHES = ['#FDE68A', '#BBF7D0', '#BFDBFE', '#FBCFE8'];

const RAIL_OPEN_W = 176;
const RAIL_COLLAPSED_W = 32;

function rotTransform(deg: number): React.CSSProperties {
  return deg ? { transform: `rotate(${deg}deg)` } : {};
}

export function EditorScreen(props: EditorScreenProps) {
  const {
    fileName, onFileNameChange, pages, signatures, globalFontFamily: gFam, globalFontSize: gSize,
    docActions, canUndo, canRedo, activePageId, setActivePageId, pageNumInput, setPageNumInput,
    goToPageIndex, zoom, setZoom, pageWrapRef, ensurePageProcessed, isExporting, showToast,
    goToUpload, goExport, onOpenGridView, onDuplicatePage, onRotatePage, onDeletePage, onAddPage,
    onReorderPages, onThumbClick, onOpenSigModal, activeTool: t, setActiveTool,
  } = props;

  const [railOpen, setRailOpen] = useState(true);
  const [hoveredPageId, setHoveredPageId] = useState<string | null>(null);
  const [fontToolFamily, setFontToolFamily] = useState("'Pretendard',sans-serif");
  const [fontToolSize, setFontToolSize] = useState(15);
  const [fontToolSizeInput, setFontToolSizeInput] = useState('15');

  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const railListRef = useRef<HTMLDivElement | null>(null);
  const draggingThumbIdRef = useRef<string | null>(null);

  const activeIndex = Math.max(0, pages.findIndex((p) => p.id === activePageId));
  const activePage = pages[activeIndex] || pages[0];
  const activePageIsPdf = activePage.kind === 'pdf';

  // ---- Pointer interactions (drag items) ----
  const pointerActions = {
    moveItem: docActions.moveItem,
    pushHistory: docActions.pushHistory,
  };
  const pointer = useCanvasPointerInteractions(pointerActions);

  // ---- Selection formatting ----
  const sel = useSelectionPreserve(pageWrapRef, showToast);

  // ---- Tool selection ----
  const selectTool = useCallback((name: Tool) => setActiveTool(name), [setActiveTool]);

  // ---- Font toolbar handlers ----
  const onFontFamilyChange = (e: ChangeEvent<HTMLSelectElement>) => setFontToolFamily(e.target.value);
  const onFontSizeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^0-9]/g, '').slice(0, 3);
    const v = parseInt(raw, 10);
    setFontToolSizeInput(raw);
    if (Number.isFinite(v) && v > 0) setFontToolSize(Math.max(8, Math.min(96, v)));
  };
  const onFontSizeBlur = () => setFontToolSizeInput(String(fontToolSize));
  const sizeDecClick = () => { const v = Math.max(8, fontToolSize - 1); setFontToolSize(v); setFontToolSizeInput(String(v)); };
  const sizeIncClick = () => { const v = Math.min(96, fontToolSize + 1); setFontToolSize(v); setFontToolSizeInput(String(v)); };

  const applyFontToSelection = useCallback(() => {
    sel.applyFontToSelection(fontToolFamily, fontToolSize);
  }, [sel, fontToolFamily, fontToolSize]);

  const applyFontToAll = useCallback(() => {
    docActions.pushHistory();
    docActions.applyGlobalFont(fontToolFamily, fontToolSize);
    showToast('문서 전체에 글꼴을 적용했습니다');
  }, [docActions, fontToolFamily, fontToolSize, showToast]);

  const resetGlobalFont = useCallback(() => {
    docActions.pushHistory();
    docActions.resetGlobalFont();
    showToast('원래 글꼴로 되돌렸습니다');
  }, [docActions, showToast]);

  // ---- Zoom ----
  const zoomIn = () => setZoom(Math.min(3, +(zoom + 0.1).toFixed(2)));
  const zoomOut = () => setZoom(Math.max(0.4, +(zoom - 0.1).toFixed(2)));
  const fitToWidth = () => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const baseW = activePageIsPdf ? (activePage.imgW || 800) : 800;
    const avail = el.clientWidth - 80;
    setZoom(+Math.max(0.3, Math.min(3, avail / baseW)).toFixed(2));
  };

  // ---- Page navigation ----
  const prevPage = () => goToPageIndex(activeIndex - 1);
  const nextPage = () => goToPageIndex(activeIndex + 1);
  const onPageNumChange = (e: ChangeEvent<HTMLInputElement>) => {
    setPageNumInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 4));
  };
  const onPageNumCommit = () => {
    const n = parseInt(pageNumInput, 10);
    if (Number.isFinite(n) && n >= 1 && n <= pages.length) goToPageIndex(n - 1);
    else setPageNumInput(String(activeIndex + 1));
  };
  const onPageNumKeyDown = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); };

  // ---- Page click (add items based on tool) ----
  const onPageClick = (e: ReactMouseEvent) => {
    if (t !== 'image' && t !== 'signature' && t !== 'shape' && !(activePageIsPdf && t === 'text')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (t === 'image') docActions.addImage(activePageId, 'img' + Date.now(), x, y);
    else if (t === 'signature') docActions.addSigField(activePageId, 'sf' + Date.now(), x, y);
    else if (t === 'shape') docActions.addShape(activePageId, 'shp' + Date.now(), x, y);
    else if (t === 'text' && activePageIsPdf) docActions.addTextBox(activePageId, 'tb' + Date.now(), x, y);
  };

  // ---- Thumb drag reorder ----
  const onThumbDragStart = (e: ReactMouseEvent) => { draggingThumbIdRef.current = (e.currentTarget as HTMLElement).dataset.pageId || null; };
  const onThumbDragOver = (e: ReactMouseEvent) => e.preventDefault();
  const onThumbDrop = (e: ReactMouseEvent) => {
    e.preventDefault();
    const targetId = (e.currentTarget as HTMLElement).dataset.pageId || '';
    const fromId = draggingThumbIdRef.current;
    if (!fromId || fromId === targetId) return;
    docActions.pushHistory();
    onReorderPages(fromId, targetId);
    draggingThumbIdRef.current = null;
  };

  // ---- Pan tool: drag-to-scroll ----
  const onScrollAreaMouseDown = (e: ReactMouseEvent) => {
    if (t !== 'pan') return;
    e.preventDefault();
    const el = scrollAreaRef.current;
    if (!el) return;
    const start = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    const onMove = (ev: MouseEvent) => { el.scrollLeft = start.sl - (ev.clientX - start.x); el.scrollTop = start.st - (ev.clientY - start.y); };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const stopProp = (e: ReactMouseEvent) => e.stopPropagation();

  // ---- Derived styles ----
  const toolBase: React.CSSProperties = { width: TOOL_BTN, height: TOOL_BTN, flex: `0 0 ${TOOL_BTN}px`, border: 'none', background: 'none', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT_STACK, color: 'oklch(40% 0.02 250)' };
  const toolActive: React.CSSProperties = { ...toolBase, background: 'oklch(93% 0.03 250)', color: ACCENT };
  const toolDisabled: React.CSSProperties = { ...toolBase, color: 'oklch(78% 0.01 250)', cursor: 'not-allowed' };

  const isTextEditable = t !== 'image' && t !== 'signature' && t !== 'pan';
  const textLayerInteractive = t === 'select' || t === 'text';

  const mainRot = activePage.rotation || 0;
  const mainRotOdd = mainRot === 90 || mainRot === 270;
  const baseW = activePageIsPdf ? activePage.imgW : 800;
  const baseH = activePageIsPdf ? activePage.imgH : null;
  const mainRotTransform = mainRot === 0 ? 'none' : mainRot === 90 ? 'rotate(90deg) translateY(-100%)' : mainRot === 180 ? 'rotate(180deg)' : 'rotate(270deg) translateX(-100%)';
  const mainRotOrigin = mainRot === 180 ? 'center center' : 'top left';

  const pageOuterStyle: React.CSSProperties = activePageIsPdf
    ? { position: 'relative', flex: 'none', width: (mainRotOdd ? baseH : baseW) || 800, height: (mainRotOdd ? baseW : baseH) || 600, zoom: zoom }
    : { position: 'relative', flex: 'none', zoom: zoom };

  const pageWrapStyle: React.CSSProperties = activePageIsPdf
    ? { width: activePage.imgW!, height: activePage.imgH!, flex: 'none', background: '#fff', boxShadow: PAGE_SHADOW, position: 'absolute', top: 0, left: 0, overflow: 'hidden', fontFamily: "'Noto Serif KR',serif", cursor: t === 'pan' ? 'grab' : (t === 'image' || t === 'signature' || t === 'text' || t === 'shape') ? 'crosshair' : 'default', transform: mainRotTransform, transformOrigin: mainRotOrigin }
    : { width: '800px', minHeight: '1040px', flex: 'none', background: '#fff', boxShadow: PAGE_SHADOW, position: 'relative', overflow: mainRot ? 'visible' : 'hidden', padding: '64px 68px', fontFamily: "'Noto Serif KR',serif", cursor: t === 'pan' ? 'grab' : (t === 'image' || t === 'signature' || t === 'shape') ? 'crosshair' : 'text', transform: mainRot ? `rotate(${mainRot}deg)` : 'none', transformOrigin: 'center center' };

  const scrollAreaStyle: React.CSSProperties = { flex: 1, overflow: 'auto', background: CANVAS_BG, padding: '40px 0 90px', display: 'flex', justifyContent: 'center', cursor: t === 'pan' ? 'grab' : 'default', transition: 'background .2s' };

  const railPanelStyle: React.CSSProperties = { width: (railOpen ? RAIL_OPEN_W : RAIL_COLLAPSED_W), flex: `0 0 ${(railOpen ? RAIL_OPEN_W : RAIL_COLLAPSED_W)}px`, borderRight: `1px solid ${BORDER}`, background: '#fbfbfa', display: 'flex', flexDirection: 'column', transition: 'flex-basis .15s ease' };
  const panelCollapseBtnStyle: React.CSSProperties = { border: 'none', background: 'none', cursor: 'pointer', color: 'oklch(45% 0.02 250)', width: 22, height: 22, flex: '0 0 22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, borderRadius: 5 };
  const panelExpandBtnStyle: React.CSSProperties = { border: 'none', background: 'none', cursor: 'pointer', color: 'oklch(45% 0.02 250)', width: '100%', height: 40, flex: '0 0 40px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 };

  const exportCtaBtnStyle = solidAccentBtn({ padding: '9px 20px', fontSize: '13.5px' });
  const applySelectionBtnStyle = outlineAccentBtn({ height: 30, padding: '0 12px', fontSize: '12.5px', flex: '0 0 auto', whiteSpace: 'nowrap' });
  const applyAllBtnStyle = solidAccentBtn({ height: 30, padding: '0 12px', fontSize: '12.5px', flex: '0 0 auto', whiteSpace: 'nowrap', borderRadius: '6px' });

  const toolbarRowStyle: React.CSSProperties = { height: TOOLBAR_H, flex: `0 0 ${TOOLBAR_H}px`, display: 'flex', alignItems: 'center', gap: 5, padding: '0 14px', borderBottom: `1px solid ${BORDER}`, background: '#fff', transition: 'flex-basis .15s' };
  const formatRowStyle: React.CSSProperties = { height: FORMAT_H, flex: `0 0 ${FORMAT_H}px`, display: 'flex', alignItems: 'center', padding: '0 18px', borderBottom: `1px solid ${BORDER}`, background: '#fbfbfa', gap: 8, overflowX: 'auto', transition: 'flex-basis .15s' };
  const railListStyle: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: '6px 14px 14px', display: 'flex', flexDirection: 'column', gap: RAIL_GAP };

  const activePagePending = activePageIsPdf && !!(activePage as any).pending;
  const activePageTextPending = activePageIsPdf && !(activePage as any).pending && !!(activePage as any).textPending;

  return (
    <div data-screen-label="편집기" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ height: 56, flex: '0 0 56px', display: 'flex', alignItems: 'center', padding: '0 18px', borderBottom: `1px solid ${BORDER}`, background: '#fff', gap: 16 }}>
        <button onClick={goToUpload} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'oklch(45% 0.02 250)', fontSize: 13, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 4px' }}>
          <div style={{ width: 7, height: 7, borderLeft: '2px solid currentColor', borderBottom: '2px solid currentColor', transform: 'rotate(45deg)' }} />
          목록
        </button>
        <div style={{ width: 1, height: 20, background: BORDER }} />
        <div contentEditable suppressContentEditableWarning style={{ fontSize: 14, fontWeight: 600, padding: '4px 6px', borderRadius: 5, minWidth: 60 }} onBlur={(e) => onFileNameChange(e.currentTarget.textContent || '')}>
          {fileName}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'oklch(55% 0.02 250)' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'oklch(55% 0.13 150)', animation: 'pdfe-pulse 2s ease-in-out infinite' }} />
          자동 저장됨
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={goExport} style={exportCtaBtnStyle}>내보내기</button>
      </div>

      {/* Toolbar */}
      <div style={toolbarRowStyle}>
        <button onClick={onOpenGridView} title="전체 페이지 보기" style={toolBase}>
          <div style={{ width: 14, height: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 2 }}>
            <div style={{ background: 'currentColor', borderRadius: 1 }} /><div style={{ background: 'currentColor', borderRadius: 1 }} />
            <div style={{ background: 'currentColor', borderRadius: 1 }} /><div style={{ background: 'currentColor', borderRadius: 1 }} />
          </div>
        </button>
        <div style={{ width: 1, height: 22, background: 'oklch(88% 0.01 250)' }} />
        <button onClick={() => selectTool('pan')} title="손 도구" style={t === 'pan' ? toolActive : toolBase}><div style={{ width: 14, height: 14, border: '2px solid currentColor', borderRadius: '3px 3px 3px 0', transform: 'rotate(45deg)' }} /></button>
        <button onClick={() => selectTool('select')} title="선택" style={t === 'select' ? toolActive : toolBase}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" /></svg>
        </button>
        <div style={{ width: 1, height: 22, background: 'oklch(88% 0.01 250)' }} />
        <button onClick={() => selectTool('text')} title="텍스트" style={t === 'text' ? toolActive : toolBase}><span style={{ fontSize: 15, fontWeight: 800 }}>T</span></button>
        <button onClick={() => selectTool('image')} title="이미지" style={t === 'image' ? toolActive : toolBase}><div style={{ width: 15, height: 12, border: '2px solid currentColor', borderRadius: 2 }} /></button>
        <button onClick={() => selectTool('shape')} title="도형" style={t === 'shape' ? toolActive : toolBase}><div style={{ width: 14, height: 14, border: '2px solid currentColor', borderRadius: 2 }} /></button>
        <button onClick={() => selectTool('signature')} title="서명" style={t === 'signature' ? toolActive : toolBase}><div style={{ width: 15, height: 2, borderBottom: '2px solid currentColor', transform: 'rotate(-8deg)' }} /></button>
        <div style={{ flex: 1 }} />
        <button onClick={() => docActions.undo()} disabled={!canUndo} title="실행 취소" style={!canUndo ? toolDisabled : toolBase}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>↩</span>
        </button>
        <button onClick={() => docActions.redo()} disabled={!canRedo} title="다시 실행" style={!canRedo ? toolDisabled : toolBase}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>↪</span>
        </button>
      </div>

      {/* Format bar */}
      <div style={formatRowStyle}>
        <select value={fontToolFamily} onChange={onFontFamilyChange} onMouseDown={sel.preserveTextSelection} style={{ height: 30, border: '1px solid oklch(85% 0.01 250)', borderRadius: 6, background: '#fff', fontSize: '12.5px', padding: '0 8px', fontFamily: 'inherit', color: 'oklch(25% 0.02 250)', flex: '0 0 auto' }}>
          {FONT_FAMILY_OPTIONS.map((fo) => <option key={fo.value} value={fo.value} style={{ fontFamily: fo.value }}>{fo.label}</option>)}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, flex: '0 0 auto' }}>
          <button onClick={sizeDecClick} onMouseDown={sel.preserveTextSelection} style={{ width: 24, height: 30, border: '1px solid oklch(85% 0.01 250)', borderRight: 'none', borderRadius: '6px 0 0 6px', background: '#fff', cursor: 'pointer', fontSize: 13, color: 'oklch(35% 0.02 250)' }}>−</button>
          <input type="text" inputMode="numeric" value={fontToolSizeInput} onChange={onFontSizeChange} onBlur={onFontSizeBlur} onMouseDown={sel.preserveTextSelection} style={{ width: 38, height: 30, border: '1px solid oklch(85% 0.01 250)', background: '#fff', fontSize: '12.5px', padding: '0 4px', fontFamily: 'inherit', color: 'oklch(25% 0.02 250)', textAlign: 'center' }} />
          <button onClick={sizeIncClick} onMouseDown={sel.preserveTextSelection} style={{ width: 24, height: 30, border: '1px solid oklch(85% 0.01 250)', borderLeft: 'none', borderRadius: '0 6px 6px 0', background: '#fff', cursor: 'pointer', fontSize: 13, color: 'oklch(35% 0.02 250)' }}>+</button>
        </div>
        <span style={{ fontSize: '11.5px', color: 'oklch(55% 0.02 250)', flex: '0 0 auto' }}>px</span>
        <div style={{ width: 1, height: 20, background: 'oklch(88% 0.01 250)', flex: '0 0 auto' }} />
        <button onClick={sel.applyBold} onMouseDown={sel.preserveTextSelection} title="굵게" style={{ width: 30, height: 30, flex: '0 0 auto', border: '1px solid oklch(85% 0.01 250)', background: '#fff', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 800, color: 'oklch(30% 0.02 250)' }}>B</button>
        <div style={{ width: 1, height: 20, background: 'oklch(88% 0.01 250)', flex: '0 0 auto' }} />
        <button onClick={() => sel.applyAlign('Left')} onMouseDown={sel.preserveTextSelection} title="왼쪽 정렬" style={{ width: 30, height: 30, flex: '0 0 auto', border: '1px solid oklch(85% 0.01 250)', background: '#fff', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 15, height: 11, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div style={{ width: 15, height: 2, background: 'oklch(35% 0.02 250)' }} /><div style={{ width: 10, height: 2, background: 'oklch(35% 0.02 250)' }} /><div style={{ width: 13, height: 2, background: 'oklch(35% 0.02 250)' }} />
          </div>
        </button>
        <button onClick={() => sel.applyAlign('Center')} onMouseDown={sel.preserveTextSelection} title="가운데 정렬" style={{ width: 30, height: 30, flex: '0 0 auto', border: '1px solid oklch(85% 0.01 250)', background: '#fff', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 15, height: 11, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ width: 15, height: 2, background: 'oklch(35% 0.02 250)' }} /><div style={{ width: 9, height: 2, background: 'oklch(35% 0.02 250)' }} /><div style={{ width: 12, height: 2, background: 'oklch(35% 0.02 250)' }} />
          </div>
        </button>
        <button onClick={() => sel.applyAlign('Right')} onMouseDown={sel.preserveTextSelection} title="오른쪽 정렬" style={{ width: 30, height: 30, flex: '0 0 auto', border: '1px solid oklch(85% 0.01 250)', background: '#fff', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 15, height: 11, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div style={{ width: 15, height: 2, background: 'oklch(35% 0.02 250)' }} /><div style={{ width: 10, height: 2, background: 'oklch(35% 0.02 250)' }} /><div style={{ width: 13, height: 2, background: 'oklch(35% 0.02 250)' }} />
          </div>
        </button>
        <div style={{ width: 1, height: 20, background: 'oklch(88% 0.01 250)', flex: '0 0 auto' }} />
        {COLOR_SWATCHES.map((hex) => (
          <button key={hex} onClick={() => sel.applyColor(hex)} onMouseDown={sel.preserveTextSelection} title={hex} style={{ width: 20, height: 20, flex: '0 0 auto', borderRadius: '50%', border: '2px solid #fff', boxShadow: `0 0 0 1px ${BORDER}`, background: hex, cursor: 'pointer', padding: 0 }} />
        ))}
        <div style={{ width: 1, height: 20, background: 'oklch(88% 0.01 250)', flex: '0 0 auto' }} />
        {HIGHLIGHT_SWATCHES.map((hex) => (
          <button key={hex} onClick={() => sel.applyHighlight(hex)} onMouseDown={sel.preserveTextSelection} title={`배경색 (${hex})`} style={{ width: 20, height: 20, flex: '0 0 auto', borderRadius: 5, border: '2px solid #fff', boxShadow: `0 0 0 1px ${BORDER}`, background: hex, cursor: 'pointer', padding: 0 }} />
        ))}
        <button onClick={() => sel.applyHighlight('transparent')} onMouseDown={sel.preserveTextSelection} title="배경색 지우기" style={{ width: 20, height: 20, flex: '0 0 auto', borderRadius: 5, border: `1px solid ${BORDER}`, background: '#fff', cursor: 'pointer', padding: 0, position: 'relative' }}>
          <div style={{ position: 'absolute', left: 2, right: 2, top: '50%', height: 1.5, background: 'oklch(55% 0.16 25)', transform: 'translateY(-50%) rotate(-45deg)' }} />
        </button>
        <div style={{ width: 1, height: 20, background: 'oklch(88% 0.01 250)', flex: '0 0 auto' }} />
        <button onClick={applyFontToSelection} onMouseDown={sel.preserveTextSelection} style={applySelectionBtnStyle}>선택 적용</button>
        <button onClick={applyFontToAll} onMouseDown={sel.preserveTextSelection} style={applyAllBtnStyle}>전체 적용</button>
        {(gFam || gSize) && (
          <button onClick={resetGlobalFont} style={{ height: 30, flex: '0 0 auto', whiteSpace: 'nowrap', border: 'none', background: 'none', color: 'oklch(50% 0.02 250)', borderRadius: 6, padding: '0 8px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}>되돌리기</button>
        )}
      </div>

      {/* Main area: rail + canvas */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Page rail */}
        <div style={railPanelStyle}>
          {railOpen ? (
            <>
              <div style={{ padding: '14px 14px 6px', fontSize: '11.5px', fontWeight: 700, color: 'oklch(50% 0.02 250)', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>페이지 ({pages.length})</span>
                <button onClick={() => setRailOpen(false)} title="목록 접기" style={panelCollapseBtnStyle}>‹</button>
              </div>
              <div ref={railListRef} className="pdfe-scroll" style={railListStyle}>
                {pages.map((p, i) => {
                  const isActive = p.id === activePageId;
                  const isPdf = p.kind === 'pdf';
                  const rot = p.rotation || 0;
                  const thumb = isPdf ? p.pdfThumb : undefined;
                  return (
                    <div
                      key={p.id}
                      draggable
                      data-page-id={p.id}
                      onDragStart={onThumbDragStart}
                      onDragOver={onThumbDragOver}
                      onDrop={onThumbDrop}
                      onClick={() => onThumbClick(p.id)}
                      style={{ display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer' }}
                    >
                      <div
                        data-page-id={p.id}
                        onMouseEnter={(e) => setHoveredPageId((e.currentTarget as HTMLElement).dataset.pageId || null)}
                        onMouseLeave={() => setHoveredPageId(null)}
                        style={{
                          width: '100%', height: RAIL_CARD_H, background: '#fff', borderRadius: 6, position: 'relative',
                          border: isActive ? `2px solid ${ACCENT}` : `1px solid ${BORDER}`,
                          boxShadow: isActive ? `0 0 0 3px color-mix(in srgb, ${ACCENT} 12%, transparent)` : 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 8, overflow: 'hidden',
                        }}
                      >
                        <div style={{ position: 'absolute', inset: 0, background: isPdf && thumb ? `#fff url(${thumb}) no-repeat center / cover` : 'transparent', ...rotTransform(rot) }} />
                        {!isPdf && <span style={{ position: 'relative', fontSize: '10.5px', color: 'oklch(55% 0.02 250)', fontFamily: "'Noto Serif KR',serif" }}>{p.label}</span>}
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'rgba(20,28,42,.4)', opacity: hoveredPageId === p.id ? 1 : 0, transition: 'opacity .12s', borderRadius: 5, pointerEvents: hoveredPageId === p.id ? 'auto' : 'none' }}>
                          <button data-page-id={p.id} onClick={(e) => { e.stopPropagation(); onDuplicatePage(p.id); }} title="복제" style={{ width: 26, height: 26, borderRadius: '50%', background: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,.25)' }}>
                            <div style={{ width: 11, height: 11, position: 'relative' }}>
                              <div style={{ position: 'absolute', left: 0, top: 0, width: 8, height: 8, border: '1.5px solid oklch(35% 0.02 250)', borderRadius: 1 }} />
                              <div style={{ position: 'absolute', right: 0, bottom: 0, width: 8, height: 8, border: '1.5px solid oklch(35% 0.02 250)', borderRadius: 1, background: '#fff' }} />
                            </div>
                          </button>
                          <button data-page-id={p.id} onClick={(e) => { e.stopPropagation(); onRotatePage(p.id, 90); }} title="회전 (PDF 페이지만 지원)" style={{ width: 26, height: 26, borderRadius: '50%', background: '#fff', border: 'none', cursor: isPdf ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,.25)', opacity: isPdf ? 1 : 0.4 }}>
                            <div style={{ width: 12, height: 12, border: '1.5px solid oklch(35% 0.02 250)', borderRadius: '50%', borderBottomColor: 'transparent', borderLeftColor: 'transparent' }} />
                          </button>
                          <button data-page-id={p.id} onClick={(e) => { e.stopPropagation(); onDeletePage(p.id); }} title="삭제" style={{ width: 26, height: 26, borderRadius: '50%', background: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,.25)', fontSize: 14, color: 'oklch(45% 0.15 25)', lineHeight: 1 }}>×</button>
                        </div>
                      </div>
                      <div style={{ textAlign: 'center', padding: '0 2px' }}>
                        <span style={{ fontSize: '11.5px', color: 'oklch(45% 0.02 250)' }}>{i + 1}</span>
                      </div>
                    </div>
                  );
                })}
                <button onClick={onAddPage} style={{ border: '1.5px dashed oklch(85% 0.01 250)', background: 'none', borderRadius: 8, padding: 14, fontSize: 12, color: 'oklch(50% 0.02 250)', cursor: 'pointer', fontFamily: 'inherit' }}>+ 페이지 추가</button>
              </div>
            </>
          ) : (
            <button onClick={() => setRailOpen(true)} title="페이지 목록 펼치기" style={panelExpandBtnStyle}>›</button>
          )}
        </div>

        {/* Canvas scroll area */}
        <div ref={scrollAreaRef} onMouseDown={onScrollAreaMouseDown} className="pdfe-scroll" style={scrollAreaStyle}>
          <div style={pageOuterStyle}>
            <div
              ref={pageWrapRef as React.RefObject<HTMLDivElement>}
              style={pageWrapStyle}
              onClick={onPageClick}
            >
              {/* PDF page */}
              {activePageIsPdf && (
                <>
                  {activePagePending && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, background: '#fff' }}>
                      <div style={spinnerAccentStyle(26, 3)} />
                      <div style={{ fontSize: '12.5px', color: 'oklch(50% 0.02 250)' }}>이 페이지를 여는 중…</div>
                    </div>
                  )}
                  {activePageTextPending && (
                    <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid oklch(88% 0.01 250)', borderRadius: 20, padding: '5px 10px', boxShadow: '0 2px 8px rgba(20,30,45,.1)', zIndex: 5 }}>
                      <div style={spinnerAccentStyle(12, 2)} />
                      <span style={{ fontSize: 11, color: 'oklch(45% 0.02 250)' }}>텍스트 인식 중…</span>
                    </div>
                  )}
                  <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, pointerEvents: 'none', backgroundImage: activePage.pdfImage ? `url(${activePage.pdfImage})` : 'none', backgroundSize: 'contain', backgroundRepeat: 'no-repeat' }} />
                  {(activePage.textItems || []).map((ti) => {
                    const fontSizePx = gSize || ti.fontSizePx || Math.max(9, ti.height * 0.85);
                    const lineH = Math.round(fontSizePx * 1.35);
                    return (
                      <div
                        key={ti.id}
                        contentEditable={isTextEditable}
                        suppressContentEditableWarning
                        onClick={stopProp}
                        onBlur={(e) => docActions.updateTextItem(activePageId, ti.id, e.currentTarget.innerHTML)}
                        style={{
                          position: 'absolute', left: ti.left, top: ti.top, width: ti.width, minHeight: ti.height,
                          fontSize: fontSizePx, lineHeight: lineH + 'px', background: 'transparent', color: '#161616',
                          fontFamily: gFam || "'Pretendard',sans-serif", whiteSpace: 'pre-wrap', wordBreak: 'keep-all', overflowWrap: 'break-word', overflow: 'visible',
                          cursor: textLayerInteractive ? 'text' : 'default', pointerEvents: textLayerInteractive ? 'auto' : 'none',
                        }}
                        dangerouslySetInnerHTML={{ __html: ti.text }}
                      />
                    );
                  })}
                </>
              )}

              {/* Doc page blocks */}
              {activePage.blocks.map((b) => {
                if (b.type === 'title') {
                  return (
                    <div
                      key={b.id} contentEditable={isTextEditable} suppressContentEditableWarning
                      onBlur={(e) => docActions.updateBlock(activePageId, b.id, 'text', e.currentTarget.innerHTML)}
                      style={{ fontSize: gSize ? gSize + 'px' : '24px', fontWeight: 700, textAlign: 'center', marginBottom: 28, letterSpacing: '.04em', fontFamily: gFam || undefined }}
                      dangerouslySetInnerHTML={{ __html: b.text }}
                    />
                  );
                }
                if (b.type === 'text') {
                  return (
                    <div
                      key={b.id} contentEditable={isTextEditable} suppressContentEditableWarning
                      onBlur={(e) => docActions.updateBlock(activePageId, b.id, 'text', e.currentTarget.innerHTML)}
                      style={{ fontSize: gSize ? gSize + 'px' : '14.5px', lineHeight: 1.9, marginBottom: 16, fontFamily: gFam || undefined }}
                      dangerouslySetInnerHTML={{ __html: b.text }}
                    />
                  );
                }
                if (b.type === 'clause') {
                  return (
                    <div key={b.id} style={{ marginBottom: 16 }}>
                      <div
                        contentEditable={isTextEditable} suppressContentEditableWarning
                        onBlur={(e) => docActions.updateBlock(activePageId, b.id, 'label', e.currentTarget.innerHTML)}
                        style={{ fontSize: gSize ? gSize + 'px' : '14.5px', fontWeight: 700, marginBottom: 4, fontFamily: gFam || undefined }}
                        dangerouslySetInnerHTML={{ __html: b.label }}
                      />
                      <div
                        contentEditable={isTextEditable} suppressContentEditableWarning
                        onBlur={(e) => docActions.updateBlock(activePageId, b.id, 'text', e.currentTarget.innerHTML)}
                        style={{ fontSize: gSize ? gSize + 'px' : '14.5px', lineHeight: 1.9, fontFamily: gFam || undefined }}
                        dangerouslySetInnerHTML={{ __html: b.text }}
                      />
                    </div>
                  );
                }
                if (b.type === 'party') {
                  const sig = signatures[b.which];
                  return (
                    <div key={b.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, padding: '16px 0', borderTop: `1px solid ${BORDER}` }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>{b.role}</div>
                        <div
                          contentEditable={isTextEditable} suppressContentEditableWarning
                          onBlur={(e) => docActions.updateBlock(activePageId, b.id, 'name', e.currentTarget.innerHTML)}
                          style={{ fontSize: gSize ? gSize + 'px' : '13.5px', color: 'oklch(35% 0.02 250)', fontFamily: gFam || undefined }}
                          dangerouslySetInnerHTML={{ __html: b.name }}
                        />
                      </div>
                      <div data-sig-which={b.which} onClick={(e) => { e.stopPropagation(); onOpenSigModal({ kind: 'fixed', which: b.which }); }} style={{ width: 170, height: 56, flex: '0 0 170px' }}>
                        {sig.signed ? (
                          <div style={{ width: '100%', height: '100%', border: '1px solid oklch(55% 0.13 150)', borderRadius: 6, background: sig.dataUrl ? `transparent url(${sig.dataUrl}) no-repeat center / contain` : 'transparent', cursor: 'pointer' }} />
                        ) : (
                          <div style={{ width: '100%', height: '100%', border: '1.5px dashed oklch(60% 0.14 250)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Pretendard',sans-serif", fontSize: '11.5px', color: ACCENT, cursor: 'pointer', background: 'oklch(97% 0.01 250)' }}>클릭하여 서명</div>
                        )}
                      </div>
                    </div>
                  );
                }
                return null;
              })}

              {/* Images */}
              {activePage.images.map((im) => (
                <div key={im.id} data-page-id={activePageId} data-item-id={im.id} className="pdfe-overlay-item" onMouseDown={pointer.onImageMouseDown} onClick={stopProp} style={{ position: 'absolute', left: im.x, top: im.y, width: im.w, height: im.h, overflow: 'visible', cursor: 'grab' }}>
                  <div style={{ width: '100%', height: '100%', border: '1px solid oklch(80% 0.01 250)', borderRadius: 4, background: 'repeating-linear-gradient(135deg, oklch(90% 0.01 250) 0 8px, oklch(94% 0.008 250) 8px 16px)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Pretendard',monospace", fontSize: 11, color: 'oklch(45% 0.02 250)', position: 'relative', pointerEvents: 'none' }}>
                    이미지 placeholder
                  </div>
                  {!isExporting && <button data-page-id={activePageId} data-item-id={im.id} onClick={(e) => { e.stopPropagation(); docActions.deleteImage(activePageId, im.id); showToast('이미지를 삭제했습니다'); }} onMouseDown={stopProp} className="pdfe-overlay-btn" style={{ position: 'absolute', top: -9, right: -9, width: 20, height: 20, borderRadius: '50%', background: '#fff', border: '1px solid oklch(80% 0.01 250)', cursor: 'pointer', fontSize: 12, lineHeight: 1, color: 'oklch(45% 0.02 250)', boxShadow: '0 1px 3px rgba(0,0,0,.15)' }}>×</button>}
                </div>
              ))}

              {/* Signature fields */}
              {activePage.signatureFields.map((f) => (
                <div key={f.id} data-page-id={activePageId} data-item-id={f.id} className="pdfe-overlay-item" onMouseDown={pointer.onSigFieldMouseDown} onClick={stopProp} style={{ position: 'absolute', left: f.x, top: f.y, width: f.w, height: f.h, overflow: 'visible', cursor: 'grab' }}>
                  {f.signed ? (
                    <div data-page-id={activePageId} data-item-id={f.id} onClick={(e) => { e.stopPropagation(); onOpenSigModal({ kind: 'extra', pageId: activePageId, id: f.id }); }} style={{ width: '100%', height: '100%', border: '1px solid oklch(55% 0.13 150)', borderRadius: 6, background: f.dataUrl ? `transparent url(${f.dataUrl}) no-repeat center / contain` : 'transparent', cursor: 'pointer' }} />
                  ) : (
                    <div data-page-id={activePageId} data-item-id={f.id} onClick={(e) => { e.stopPropagation(); onOpenSigModal({ kind: 'extra', pageId: activePageId, id: f.id }); }} style={{ width: '100%', height: '100%', border: '1.5px dashed oklch(60% 0.14 250)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Pretendard',sans-serif", fontSize: '11.5px', color: ACCENT, cursor: 'pointer', background: '#fff' }}>서명 필드 · 클릭</div>
                  )}
                  {!isExporting && <button data-page-id={activePageId} data-item-id={f.id} onClick={(e) => { e.stopPropagation(); docActions.deleteSigField(activePageId, f.id); showToast('서명 필드를 삭제했습니다'); }} onMouseDown={stopProp} className="pdfe-overlay-btn" style={{ position: 'absolute', top: -9, right: -9, width: 20, height: 20, borderRadius: '50%', background: '#fff', border: '1px solid oklch(80% 0.01 250)', cursor: 'pointer', fontSize: 12, lineHeight: 1, color: 'oklch(45% 0.02 250)', boxShadow: '0 1px 3px rgba(0,0,0,.15)' }}>×</button>}
                </div>
              ))}

              {/* Shapes */}
              {activePage.shapes.map((sh) => (
                <div key={sh.id} data-page-id={activePageId} data-item-id={sh.id} className="pdfe-overlay-item" onMouseDown={pointer.onShapeMouseDown} onClick={stopProp} style={{ position: 'absolute', left: sh.x, top: sh.y, width: sh.w, height: sh.h, border: `2px solid ${ACCENT}`, borderRadius: 4, background: 'oklch(55% 0.14 250 / 6%)', cursor: 'grab' }}>
                  {!isExporting && <button data-page-id={activePageId} data-item-id={sh.id} onClick={(e) => { e.stopPropagation(); docActions.deleteShape(activePageId, sh.id); showToast('도형을 삭제했습니다'); }} onMouseDown={stopProp} className="pdfe-overlay-btn" style={{ position: 'absolute', top: -9, right: -9, width: 18, height: 18, borderRadius: '50%', background: '#fff', border: '1px solid oklch(80% 0.01 250)', cursor: 'pointer', fontSize: 11, lineHeight: 1, color: 'oklch(45% 0.02 250)', boxShadow: '0 1px 3px rgba(0,0,0,.15)' }}>×</button>}
                </div>
              ))}

              {/* Text boxes */}
              {activePage.textBoxes.map((tb) => (
                <div key={tb.id} className="pdfe-overlay-item" onClick={stopProp} style={{ position: 'absolute', left: tb.x, top: tb.y, width: tb.w, height: tb.h, overflow: 'visible' }}>
                  <div
                    contentEditable suppressContentEditableWarning
                    onBlur={(e) => docActions.updateTextBoxText(activePageId, tb.id, e.currentTarget.innerHTML)}
                    style={{ width: '100%', height: '100%', background: '#fff', border: '1px solid oklch(80% 0.01 250)', borderRadius: 4, padding: '6px 8px', fontFamily: gFam || "'Pretendard',sans-serif", fontSize: (gSize || 13.5) + 'px', lineHeight: 1.5, outline: 'none', overflow: 'auto' }}
                    dangerouslySetInnerHTML={{ __html: tb.text }}
                  />
                  {!isExporting && (
                    <button data-page-id={activePageId} data-item-id={tb.id} onMouseDown={pointer.onTextBoxMouseDown} title="이동" className="pdfe-overlay-btn" style={{ position: 'absolute', top: -9, left: -9, width: 18, height: 18, borderRadius: '50%', background: '#fff', border: '1px solid oklch(80% 0.01 250)', cursor: 'grab', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,.15)', padding: 0 }}>
                      <div style={{ width: 8, height: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                        <div style={{ width: 2, height: 2, borderRadius: '50%', background: 'oklch(50% 0.02 250)' }} />
                        <div style={{ width: 2, height: 2, borderRadius: '50%', background: 'oklch(50% 0.02 250)' }} />
                        <div style={{ width: 2, height: 2, borderRadius: '50%', background: 'oklch(50% 0.02 250)' }} />
                        <div style={{ width: 2, height: 2, borderRadius: '50%', background: 'oklch(50% 0.02 250)' }} />
                      </div>
                    </button>
                  )}
                  {!isExporting && <button data-page-id={activePageId} data-item-id={tb.id} onClick={(e) => { e.stopPropagation(); docActions.deleteTextBox(activePageId, tb.id); showToast('텍스트 박스를 삭제했습니다'); }} onMouseDown={stopProp} className="pdfe-overlay-btn" style={{ position: 'absolute', top: -9, right: -9, width: 18, height: 18, borderRadius: '50%', background: '#fff', border: '1px solid oklch(80% 0.01 250)', cursor: 'pointer', fontSize: 11, lineHeight: 1, color: 'oklch(45% 0.02 250)', boxShadow: '0 1px 3px rgba(0,0,0,.15)' }}>×</button>}
                </div>
              ))}

            </div>
          </div>
        </div>
      </div>

      {/* Bottom nav bar */}
      <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: '#fff', border: `1px solid oklch(88% 0.01 250)`, borderRadius: 12, boxShadow: '0 8px 28px rgba(20,30,45,.16)', display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', zIndex: 30, fontFamily: "'Pretendard',sans-serif" }}>
        <button onClick={prevPage} disabled={activeIndex <= 0} style={{ width: 28, height: 28, border: 'none', background: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 16, color: 'oklch(35% 0.02 250)' }}>‹</button>
        <input value={pageNumInput} onChange={onPageNumChange} onBlur={onPageNumCommit} onKeyDown={onPageNumKeyDown} style={{ width: 34, height: 28, textAlign: 'center', border: '1px solid oklch(88% 0.01 250)', borderRadius: 6, fontSize: '12.5px', fontFamily: 'inherit' }} />
        <span style={{ fontSize: 12, color: 'oklch(50% 0.02 250)', padding: '0 2px', whiteSpace: 'nowrap' }}>/ {pages.length}</span>
        <button onClick={nextPage} disabled={activeIndex >= pages.length - 1} style={{ width: 28, height: 28, border: 'none', background: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 16, color: 'oklch(35% 0.02 250)' }}>›</button>
        <div style={{ width: 1, height: 20, background: 'oklch(88% 0.01 250)', margin: '0 4px' }} />
        <button onClick={zoomOut} style={{ width: 28, height: 28, border: 'none', background: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 15, color: 'oklch(35% 0.02 250)' }}>−</button>
        <span style={{ fontSize: 12, color: 'oklch(45% 0.02 250)', width: 42, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        <button onClick={zoomIn} style={{ width: 28, height: 28, border: 'none', background: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 15, color: 'oklch(35% 0.02 250)' }}>+</button>
        <div style={{ width: 1, height: 20, background: 'oklch(88% 0.01 250)', margin: '0 4px' }} />
        <button onClick={fitToWidth} title="폭 맞춤" style={{ width: 28, height: 28, border: 'none', background: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: 'oklch(35% 0.02 250)' }}>⇔</button>
      </div>
    </div>
  );
}

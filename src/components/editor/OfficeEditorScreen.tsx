import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeftRight, BookOpen, ChevronLeft, ChevronRight, Hand, LayoutGrid, Minus, MousePointer2, Play, Plus, Redo2, SkipBack, Undo2, X } from 'lucide-react';
import type { OfficeFormat } from '../../documents/formats';
import type { FormatValue, OfficeCommand, OfficePageCommand, OfficeSession, OfficeState } from '../../documents/officeTypes';
import { ACCENT, BORDER, CANVAS_BG, FONT_STACK, PANEL_SHADOW, RAIL_CARD_H, SURFACE, TEXT, TEXT_MUTED, TOOLBAR_H, toolActive, toolBase, toolDisabled } from '../../styles/theme';
import { DocumentHeader } from './DocumentHeader';

export interface OfficeEditorScreenProps {
  session: OfficeSession;
  mount: HTMLElement;
  fileName: string;
  format: OfficeFormat;
  busy: boolean;
  saveLabel: string;
  saveError: string | null;
  onFileNameChange: (name: string) => void;
  onHome: () => void;
  onExport: () => void;
  onRetrySave: () => void;
  onError: (message: string) => void;
}

type FormattingKey = keyof OfficeState['formatting'];
function valueLabel(value: FormatValue<unknown>): string {
  return value.kind === 'mixed' ? '혼합' : value.kind === 'unavailable' ? '확인 불가' : typeof value.value === 'boolean' ? value.value ? '켜짐' : '꺼짐' : String(value.value);
}
const fieldStyle: CSSProperties = { height: 32, minWidth: 0, border: `1px solid ${BORDER}`, borderRadius: 8, background: SURFACE, color: TEXT, padding: '0 6px', fontFamily: FONT_STACK };

function OfficePageThumbnail({ page, load, enabled }: { page: number; load: (page: number, signal: AbortSignal) => Promise<Blob>; enabled: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const imageUrl = useRef('');
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setImage('');
    return () => {
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = '';
    };
  }, [page]);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    let request: AbortController | undefined;
    let timer: number | undefined;
    setError('');
    if (!enabled) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) {
        window.clearTimeout(timer);
        request?.abort();
        request = undefined;
        if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
        imageUrl.current = '';
        setImage('');
        return;
      }
      if (request) return;
      const pending = new AbortController();
      request = pending;
      timer = window.setTimeout(() => {
        void load(page, pending.signal).then(blob => {
          if (pending.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
          imageUrl.current = url;
          setImage(url);
        }).catch(reason => {
          if (!pending.signal.aborted && !(reason instanceof DOMException && reason.name === 'AbortError')) setError('미리보기 실패');
        });
      }, 300);
    }, { rootMargin: '100px' });
    observer.observe(target);
    return () => { window.clearTimeout(timer); request?.abort(); observer.disconnect(); };
  }, [page, load, enabled]);
  return <div ref={element} style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    {image ? <img src={image} alt={`${page + 1} 페이지 미리보기`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <span style={{ color: TEXT_MUTED, fontSize: 11 }}>{error || '불러오는 중'}</span>}
  </div>;
}

export function OfficeEditorScreen(p: OfficeEditorScreenProps) {
  const [state, setState] = useState(() => p.session.getState());
  const currentSession = useRef<OfficeSession | null>(p.session);
  const stableToolbar = useRef(state);
  const toolbar = state.composing && stableToolbar.current.sessionId === state.sessionId ? stableToolbar.current : state;
  const busy = useRef(p.busy);
  useLayoutEffect(() => { busy.current = p.busy; }, [p.busy]);
  useLayoutEffect(() => {
    currentSession.current = p.session;
    return () => { currentSession.current = null; };
  }, [p.session]);
  const placeholder = useRef<HTMLDivElement>(null);
  const activeCard = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const gridButton = useRef<HTMLButtonElement>(null);
  const gridDialog = useRef<HTMLDivElement>(null);
  const [navigationClearance, setNavigationClearance] = useState(0);
  const [railOpen, setRailOpen] = useState(true);
  const [pageInput, setPageInput] = useState('');
  const [gridOpen, setGridOpen] = useState(false);
  const gridEpoch = useRef(0);
  useLayoutEffect(() => { gridEpoch.current += 1; }, [gridOpen, p.session]);
  const [gridPage, setGridPage] = useState(0);
  const pageView = p.session.pageView ? state.pageView : undefined;
  const interaction = pageView && p.session.interaction ? state.interaction : undefined;
  const loadThumbnail = useMemo(() => {
    const cache = new Map<number, Blob>();
    let queue: Promise<unknown> = Promise.resolve();
    const controller = p.session.pageView;
    const revision = pageView?.renderRevision;
    return (page: number, signal: AbortSignal) => {
      const result = queue.then(async () => {
        signal.throwIfAborted();
        const cached = cache.get(page);
        if (cached) {
          cache.delete(page);
          cache.set(page, cached);
          return cached;
        }
        if (!controller || revision === undefined || p.session.getState().pageView?.renderRevision !== revision) {
          throw new DOMException('페이지가 변경되었습니다.', 'AbortError');
        }
        const image = await controller.thumbnail(page, revision);
        cache.set(page, image);
        if (cache.size > 24) cache.delete(cache.keys().next().value!);
        signal.throwIfAborted();
        return image;
      });
      queue = result.then(() => undefined, () => undefined);
      return result;
    };
  }, [p.session, pageView?.renderRevision]);
  useEffect(() => { setRailOpen(true); setGridOpen(false); }, [p.session]);
  useEffect(() => { setPageInput(String((pageView?.currentPage ?? 0) + 1)); }, [p.session, pageView?.currentPage]);
  useEffect(() => { activeCard.current?.scrollIntoView({ block: 'nearest' }); }, [p.session, pageView?.currentPage, railOpen]);
  useLayoutEffect(() => {
    const nav = navigation.current;
    const container = nav?.parentElement;
    if (!nav || !container) return;
    const measure = () => setNavigationClearance(Math.max(0, container.getBoundingClientRect().bottom - nav.getBoundingClientRect().top));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    observer.observe(container);
    return () => observer.disconnect();
  }, [p.session, !!pageView]);
  useLayoutEffect(() => {
    const accept = (next: OfficeState) => {
      if (!next.composing || stableToolbar.current.sessionId !== next.sessionId) stableToolbar.current = next;
      setState(next);
    };
    const unsubscribe = p.session.subscribe(accept);
    accept(p.session.getState());
    return unsubscribe;
  }, [p.session]);

  useLayoutEffect(() => {
    const element = placeholder.current;
    if (!element) return;
    const position = () => {
      const rect = element.getBoundingClientRect();
      Object.assign(p.mount.style, { position: 'fixed', top: `${rect.top}px`, left: `${rect.left}px`, width: `${Math.max(1, rect.width)}px`, height: `${Math.max(1, rect.height)}px`, visibility: gridOpen ? 'hidden' : 'visible', zIndex: '10' });
    };
    position();
    p.mount.inert = gridOpen;
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      // Moving an iframe between parents reloads it. Keep its real-sized body mount.
      p.mount.inert = true;
      Object.assign(p.mount.style, { top: '0px', left: '-100000px', visibility: 'hidden', zIndex: '-1' });
    };
  }, [p.mount, gridOpen]);

  useEffect(() => {
    // Inert would blur the editor and force an in-progress IME composition to end.
    p.mount.inert = gridOpen || (p.busy && !state.composing);
  }, [p.mount, p.busy, state.composing, gridOpen]);

  const lockReason = p.busy || state.busy ? '작업이 끝난 뒤 사용할 수 있습니다.' : !state.ready ? '문서를 준비하고 있습니다.' : '';
  const reason = (type: OfficeCommand['type']) => {
    if (lockReason) return lockReason;
    if (type === 'undo' && !toolbar.canUndo) return '취소할 작업이 없습니다.';
    if (type === 'redo' && !toolbar.canRedo) return '다시 실행할 작업이 없습니다.';
    if (!toolbar.enabled[type] && type in toolbar.formatting) {
      const value = toolbar.formatting[type as FormattingKey];
      if (value.kind === 'unavailable') return value.reason;
    }
    return toolbar.enabled[type] ? '' : '현재 선택에서는 지원하지 않습니다.';
  };
  const prepareAction = async () => {
    if (currentSession.current !== p.session || busy.current) return null;
    const before = p.session.getState();
    if (before.busy || !before.ready || !await p.session.flush()) return null;
    if (currentSession.current !== p.session || busy.current) return null;
    const current = p.session.getState();
    return current.composing || current.busy || !current.ready ? null : current;
  };
  const reportError = (error: unknown) => {
    if (currentSession.current === p.session) p.onError(error instanceof Error ? error.message : String(error));
  };
  const executeHeader = async (action: () => void) => {
    try { if (await prepareAction()) action(); }
    catch (error) { reportError(error); }
  };
  const execute = async (command: OfficeCommand) => {
    if (reason(command.type)) return;
    try {
      const current = await prepareAction();
      if (!current?.enabled[command.type]) return;
      const result = await p.session.execute(command);
      if (currentSession.current === p.session && !result.ok) p.onError(result.reason);
    } catch (error) { reportError(error); }
  };
  const executePage = async (command: OfficePageCommand) => {
    if (lockReason || !p.session.pageView || !pageView?.pageCount) return;
    try {
      const current = await prepareAction();
      if (!current?.pageView?.pageCount) return;
      const result = await p.session.pageView.execute(command);
      if (currentSession.current === p.session && !result.ok) p.onError(result.reason);
    } catch (error) { reportError(error); }
  };
  const executeInteraction = async (command: Parameters<NonNullable<OfficeSession['interaction']>['execute']>[0]) => {
    if (lockReason || !p.session.interaction) return;
    try {
      if (!await prepareAction()) return;
      const result = await p.session.interaction.execute(command);
      if (currentSession.current === p.session && !result.ok) p.onError(result.reason);
    } catch (error) { reportError(error); }
  };
  const copySelection = async () => {
    if (lockReason || !p.session.interaction) return;
    try {
      const current = await prepareAction();
      if (!current?.interaction || current.interaction.copyDisabledReason) return;
      const text = await p.session.interaction.selectedText();
      if (currentSession.current === p.session && text) await navigator.clipboard.writeText(text);
    } catch (error) { reportError(error); }
  };
  const openGrid = async () => {
    if (lockReason || !pageView) return;
    try {
      const current = await prepareAction();
      if (!current?.pageView?.pageCount) return;
      setGridPage(current.pageView.currentPage);
      setGridOpen(true);
    } catch (error) { reportError(error); }
  };
  const openPptxGrid = async () => {
    if (lockReason || p.format !== 'pptx') return;
    try {
      if (!await prepareAction()) return;
      const frame = p.mount.querySelector('iframe');
      const event = frame?.contentDocument?.createEvent('Event');
      if (!frame?.contentWindow || !event) throw new Error('PPTX 편집 화면을 찾을 수 없습니다.');
      event.initEvent('pdfe-open-slide-grid', false, false);
      frame.contentWindow.dispatchEvent(event);
    } catch (error) { reportError(error); }
  };
  const startPptxPreview = async (fromStart: boolean) => {
    if (lockReason || p.format !== 'pptx') return;
    try {
      if (!await prepareAction()) return;
      const frame = p.mount.querySelector('iframe');
      const event = frame?.contentDocument?.createEvent('Event');
      if (!frame?.contentWindow || !event) throw new Error('PPTX 편집 화면을 찾을 수 없습니다.');
      event.initEvent(fromStart ? 'pdfe-start-preview-from-start' : 'pdfe-start-preview', false, false);
      frame.contentWindow.dispatchEvent(event);
      // 슬라이드 쇼가 방향키·스페이스·Esc를 받도록 편집 프레임으로 포커스를 넘긴다.
      frame.contentWindow.focus();
    } catch (error) { reportError(error); }
  };
  const openGridPage = async (page: number) => {
    if (lockReason || !p.session.pageView) return;
    const epoch = gridEpoch.current;
    try {
      const current = await prepareAction();
      if (!current?.pageView || gridEpoch.current !== epoch) return;
      const result = await p.session.pageView.execute({ type: 'goToPage', page });
      if (currentSession.current !== p.session || gridEpoch.current !== epoch) return;
      if (!result.ok) { p.onError(result.reason); return; }
      setGridOpen(false);
    } catch (error) { reportError(error); }
  };
  useEffect(() => {
    if (!gridOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setGridOpen(false); }
    };
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('keydown', close);
      gridButton.current?.focus({ preventScroll: true });
    };
  }, [gridOpen]);
  const commitPage = () => {
    const page = Number(pageInput);
    if (pageView && Number.isInteger(page) && page >= 1 && page <= pageView.pageCount) {
      if (page - 1 !== pageView.currentPage) void executePage({ type: 'goToPage', page: page - 1 });
    } else setPageInput(String((pageView?.currentPage ?? 0) + 1));
  };
  const spreadStart = pageView?.twoPage && pageView.currentPage > 0
    ? pageView.currentPage - (pageView.currentPage - 1) % 2 : pageView?.currentPage ?? 0;
  const spreadLength = pageView?.twoPage && spreadStart > 0 ? 2 : 1;
  const formatTitle = (key: FormattingKey, label: string) => `${label}: ${valueLabel(toolbar.formatting[key])}${reason(key) ? ` — ${reason(key)}` : ''}`;
  const font = toolbar.formatting.fontFamily;
  const size = toolbar.formatting.fontSize;
  const color = toolbar.formatting.color;
  const sizeField = useRef<HTMLInputElement>(null);
  const [sizeInput, setSizeInput] = useState('');
  useLayoutEffect(() => {
    if (document.activeElement !== sizeField.current) setSizeInput(size.kind === 'uniform' ? String(size.value) : '');
  }, [p.session, toolbar.selectionRevision, size]);
  const commitSize = (value: string) => {
    if (!value.trim()) return;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) { p.onError('글자 크기는 양수 pt 값이어야 합니다.'); return; }
    if (size.kind !== 'uniform' || size.value !== number) void execute({ type: 'fontSize', value: number });
  };
  const formattingControls = <>
      {(['bold', 'italic', 'underline'] as const).map((type, index) => {
        const value = toolbar.formatting[type];
        const label = ['굵게', '기울임', '밑줄'][index];
        return <span key={type} title={formatTitle(type, label)}>
          <button disabled={!!reason(type)} aria-label={formatTitle(type, label)} aria-pressed={value.kind === 'mixed' ? 'mixed' : value.kind === 'uniform' && value.value}
            onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void execute({ type })}
            style={{ ...(reason(type) ? toolDisabled : value.kind === 'uniform' && value.value ? toolActive : toolBase), ...(pageView ? { border: `1px solid ${value.kind === 'uniform' && value.value ? TEXT : BORDER}` } : {}), width: 'auto', padding: '0 10px', fontWeight: type === 'bold' ? 700 : 400, fontStyle: type === 'italic' ? 'italic' : 'normal', textDecoration: type === 'underline' ? 'underline' : 'none' }}>
            {label}{value.kind !== 'uniform' && <small style={{ marginLeft: 4 }}>{valueLabel(value)}</small>}
          </button>
        </span>;
      })}
      <label title={formatTitle('fontFamily', '글꼴')} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>글꼴
        <select aria-label={formatTitle('fontFamily', '글꼴')} disabled={!!reason('fontFamily')} value={font.kind === 'uniform' ? font.value : ''} onChange={e => void execute({ type: 'fontFamily', value: e.target.value })} style={{ ...fieldStyle, maxWidth: 170 }}>
          {font.kind !== 'uniform' && <option value="" disabled>{valueLabel(font)}</option>}
          {font.kind === 'uniform' && !state.fonts.some(item => item.value === font.value) && <option value={font.value}>{font.value}</option>}
          {state.fonts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label title={formatTitle('fontSize', '글자 크기')} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input ref={sizeField} key={state.sessionId} aria-label={formatTitle('fontSize', '글자 크기 (pt)')} type="number" min="0.01" step="any" disabled={!!reason('fontSize')} value={sizeInput} onChange={e => setSizeInput(e.target.value)} placeholder={valueLabel(size)} onBlur={e => commitSize(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur(); }} style={{ ...fieldStyle, width: 95 }} />pt
      </label>
      <label title={formatTitle('color', '글자색')} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>글자색
        <input aria-label={formatTitle('color', '글자색')} type="color" disabled={!!reason('color')} value={color.kind === 'uniform' ? color.value : '#000000'} onChange={e => void execute({ type: 'color', value: e.target.value })} style={{ ...fieldStyle, width: 36 }} />
        <small>{valueLabel(color)}</small>
      </label>
  </>;

  return <div data-screen-label="편집기" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', color: TEXT, fontFamily: FONT_STACK }}>
    <DocumentHeader fileName={p.fileName} format={p.format} busy={p.busy || state.busy} preserveEditorFocus={!state.composing}
      saveLabel={p.saveLabel} saveError={p.saveError} onFileNameChange={p.onFileNameChange} onHome={() => void executeHeader(p.onHome)} onExport={() => void executeHeader(p.onExport)} onRetrySave={() => void executeHeader(p.onRetrySave)} />
    {pageView && <div role="toolbar" aria-label="문서 도구" style={{ minHeight: TOOLBAR_H, flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 20px', borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
      <button ref={gridButton} style={toolBase} aria-label="전체 페이지 보기" aria-expanded={gridOpen} title="전체 페이지 보기" disabled={!!lockReason} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void openGrid()}><LayoutGrid size={22} strokeWidth={1.5} /></button>
      {(interaction || p.format === 'docx') && <>
        <div className="pdfe-segmented" role="group" aria-label="편집 도구">
          {(['pan', 'select'] as const).map(tool => {
            const Icon = tool === 'pan' ? Hand : MousePointer2;
            const label = tool === 'pan' ? '손 도구' : '선택';
            return <button key={tool} aria-label={label} aria-pressed={interaction?.tool === tool} title={interaction ? label : `DOCX 엔진은 ${tool === 'pan' ? '손' : '선택'} 도구를 지원하지 않습니다.`} disabled={!!lockReason || !interaction} style={{ ...(interaction?.tool === tool ? toolActive : toolBase), flex: 1 }} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void executeInteraction({ type: 'tool', value: tool })}><Icon size={22} strokeWidth={1.5} /></button>;
          })}
        </div>
      </>}
      {formattingControls}
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 'auto' }}>
        {interaction?.tool === 'select' && interaction.hasSelection && <div className="pdfe-selection-row" style={{ display: 'flex', alignItems: 'center', flexWrap: 'nowrap', gap: 8 }}>
          <span role="status" aria-live="polite">선택됨</span>
          <button title={lockReason || interaction.copyDisabledReason || '텍스트 복사'} disabled={!!lockReason || !!interaction.copyDisabledReason} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void copySelection()}>복사</button>
        </div>}
        {(['undo', 'redo'] as const).map(type => <button key={type} style={toolBase} disabled={!!reason(type)} aria-label={type === 'undo' ? '실행 취소' : '다시 실행'} title={reason(type) || (type === 'undo' ? '실행 취소' : '다시 실행')} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void execute({ type })}>{type === 'undo' ? <Undo2 size={22} strokeWidth={1.5} /> : <Redo2 size={22} strokeWidth={1.5} />}</button>)}
      </div>
    </div>}
    {!pageView && p.format === 'pptx' && <div role="toolbar" aria-label="문서 도구" style={{ minHeight: TOOLBAR_H, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 20px', borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
      <button ref={gridButton} style={toolBase} aria-label="전체 슬라이드 보기" title="전체 슬라이드 보기" disabled={!!lockReason} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void openPptxGrid()}><LayoutGrid size={22} strokeWidth={1.5} /></button>
      <button style={toolBase} aria-label="현재 슬라이드부터 슬라이드 쇼" title={lockReason || '현재 슬라이드부터 슬라이드 쇼'} disabled={!!lockReason} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void startPptxPreview(false)}><Play size={22} strokeWidth={1.5} /></button>
      <button style={toolBase} aria-label="처음부터 슬라이드 쇼" title={lockReason || '처음부터 슬라이드 쇼'} disabled={!!lockReason} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void startPptxPreview(true)}><SkipBack size={22} strokeWidth={1.5} /></button>
      <label title={reason('zoom') || '배율'} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>배율
        <select aria-label="배율" disabled={!!reason('zoom')} value={state.zoom} onChange={e => void execute({ type: 'zoom', value: Number(e.target.value) })} style={fieldStyle}>
          {[...new Set([0.5, 0.75, 1, 1.25, 1.5, 2, state.zoom])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
        </select>
      </label>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {(['undo', 'redo'] as const).map(type => <button key={type} style={toolBase} disabled={!!reason(type)} aria-label={type === 'undo' ? '실행 취소' : '다시 실행'} title={reason(type) || (type === 'undo' ? '실행 취소' : '다시 실행')} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void execute({ type })}>{type === 'undo' ? <Undo2 size={22} strokeWidth={1.5} /> : <Redo2 size={22} strokeWidth={1.5} />}</button>)}
      </div>
    </div>}
    {!pageView && p.format !== 'pptx' && <div role="toolbar" aria-label="문서 서식" style={{ minHeight: TOOLBAR_H, flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 20px', borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
      {(['undo', 'redo'] as const).map(type => <span key={type} title={reason(type) || (type === 'undo' ? '실행 취소' : '다시 실행')}>
        <button disabled={!!reason(type)} aria-label={type === 'undo' ? '실행 취소' : '다시 실행'} style={reason(type) ? toolDisabled : toolBase} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void execute({ type })}>
          {type === 'undo' ? <Undo2 size={22} /> : <Redo2 size={22} />}
        </button>
      </span>)}
      {formattingControls}
      <label title={reason('zoom') || '배율'} style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>배율
        <select aria-label="배율" disabled={!!reason('zoom')} value={state.zoom} onChange={e => void execute({ type: 'zoom', value: Number(e.target.value) })} style={fieldStyle}>
          {[...new Set([0.5, 0.75, 1, 1.25, 1.5, 2, state.zoom])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
        </select>
      </label>
    </div>}
    {p.format === 'pptx' && <div role="note" style={{ padding: '6px 20px', background: SURFACE, fontSize: 13 }}>변환 편집 · 원본 보존 — 고급 서식·마스터가 달라질 수 있습니다. 원본 애니메이션·화면 전환은 가져오지 않으며, 편집기에서 추가한 애니메이션은 슬라이드 쇼에서만 재생되고 PPTX 수정본에는 저장되지 않습니다.</div>}
    {lockReason && <div role="status" style={{ padding: '4px 20px', fontSize: 13, color: TEXT_MUTED }}>{lockReason}</div>}
    {p.format !== 'hwp' && p.format !== 'hwpx' && state.warnings.length > 0 && <div role="note" style={{ padding: '6px 20px', maxHeight: 100, overflow: 'auto', background: SURFACE, fontSize: 13 }}>{state.warnings.map((warning, index) => <div key={`${index}:${warning}`}>{warning}</div>)}</div>}
    <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
      {pageView && <aside aria-label="페이지 목록" style={{ width: railOpen ? 176 : 32, flexShrink: 0, borderRight: `1px solid ${BORDER}`, background: SURFACE, display: 'flex', flexDirection: 'column' }}>
        <button aria-label={railOpen ? '페이지 목록 접기' : '페이지 목록 펼치기'} onClick={() => setRailOpen(!railOpen)} style={{ flexShrink: 0, border: 0, background: 'var(--pdfe-button-bg, transparent)', padding: '12px 4px', color: TEXT_MUTED, fontSize: 13, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 4 }}>
          {railOpen && `페이지 (${pageView.pageCount})`}{railOpen ? <ChevronLeft size={22} strokeWidth={1.5} /> : <ChevronRight size={22} strokeWidth={1.5} />}
        </button>
        {railOpen && <div className="pdfe-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}>
          {Array.from({ length: pageView.pageCount }, (_, page) => <div key={`${state.sessionId}:${page}`} ref={page === pageView.currentPage ? activeCard : undefined} className="pdfe-page-card" data-selected={page === pageView.currentPage} style={{ marginBottom: 14 }}>
            <div style={{ height: RAIL_CARD_H, padding: 8, position: 'relative', background: '#fff', borderRadius: 10, border: `${page === pageView.currentPage ? 2 : 1}px solid ${page === pageView.currentPage ? ACCENT : BORDER}` }}>
              <OfficePageThumbnail page={page} load={loadThumbnail} enabled={!lockReason && !state.composing && !gridOpen} />
              <button className="pdfe-thumb-hit" aria-label={`${page + 1} 페이지 열기`} aria-current={page === pageView.currentPage ? 'page' : undefined} disabled={!!lockReason} onClick={() => void executePage({ type: 'goToPage', page })} />
            </div>
            <div style={{ textAlign: 'center', fontSize: 12, marginTop: 5 }}>{page + 1}</div>
          </div>)}
        </div>}
      </aside>}
      <div ref={placeholder} aria-label={`${p.format.toUpperCase()} 문서 편집 영역`} style={{ flex: 1, minWidth: 0, minHeight: 0, marginBottom: pageView ? navigationClearance : 0, background: CANVAS_BG }} />
      {pageView && <nav ref={navigation} className="pdfe-bottom-nav" aria-label="페이지 탐색 및 배율" style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 24, boxShadow: PANEL_SHADOW, display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', zIndex: 30 }}>
        <button aria-label="두 페이지 보기" title={p.format === 'docx' ? 'DOCX 엔진은 두 페이지 보기를 지원하지 않습니다.' : '두 페이지 보기'} aria-pressed={pageView.twoPage} disabled={!!lockReason || p.format === 'docx'} style={pageView.twoPage ? toolActive : toolBase} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void executePage({ type: 'twoPage', value: !pageView.twoPage })}><BookOpen size={22} strokeWidth={1.5} /></button>
        <button aria-label="이전 페이지" disabled={!!lockReason || spreadStart === 0} onClick={() => void executePage({ type: 'goToPage', page: pageView.twoPage ? Math.max(0, spreadStart - 2) : pageView.currentPage - 1 })}><ChevronLeft size={22} strokeWidth={1.5} /></button>
        <input aria-label="현재 페이지" disabled={!!lockReason} value={pageInput} onChange={e => setPageInput(e.target.value)} onBlur={commitPage} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitPage(); }} style={{ width: 36, textAlign: 'center' }} /><span style={{ whiteSpace: 'nowrap' }}>/ {pageView.pageCount}</span>
        <button aria-label="다음 페이지" disabled={!!lockReason || spreadStart + spreadLength >= pageView.pageCount} onClick={() => void executePage({ type: 'goToPage', page: spreadStart + spreadLength })}><ChevronRight size={22} strokeWidth={1.5} /></button>
        <button aria-label="축소" disabled={!!reason('zoom') || state.zoom <= .25} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void execute({ type: 'zoom', value: Math.max(25, Math.round(state.zoom * 100) - 5) / 100 })}><Minus size={22} strokeWidth={1.5} /></button>
        <span>{Math.round(state.zoom * 100)}%</span>
        <button aria-label="확대" disabled={!!reason('zoom') || state.zoom >= 4} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void execute({ type: 'zoom', value: Math.min(400, Math.round(state.zoom * 100) + 5) / 100 })}><Plus size={22} strokeWidth={1.5} /></button>
        <button aria-label="폭 맞춤" title="폭 맞춤" disabled={!!lockReason} onPointerDown={e => { if (!state.composing) e.preventDefault(); }} onClick={() => void executePage({ type: 'fitWidth' })}><ArrowLeftRight size={22} strokeWidth={1.5} /></button>
      </nav>}
    </div>
    {gridOpen && pageView && <div ref={gridDialog} className="pdfe-screen-enter" role="dialog" aria-modal="true" aria-label="전체 페이지 보기" onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const buttons = gridDialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }} style={{ position: 'fixed', inset: 0, background: CANVAS_BG, zIndex: 40, display: 'flex', flexDirection: 'column' }}>
      <div className="pdfe-grid-header" style={{ minHeight: 56, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '12px 20px', borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
        <strong style={{ fontSize: 17, fontWeight: 500, letterSpacing: '-.025em' }}>모든 페이지 ({pageView.pageCount})</strong><div style={{ flex: 1 }} />
        <button aria-label="전체 페이지 닫기" title="완료" autoFocus onClick={() => setGridOpen(false)}><X size={24} strokeWidth={1.5} /></button>
      </div>
      <div className="pdfe-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 20, alignContent: 'start' }}>
        {Array.from({ length: pageView.pageCount }, (_, page) => <div key={`${state.sessionId}:${page}`} className="pdfe-page-card" data-selected={gridPage === page} style={{ border: `2px solid ${gridPage === page ? ACCENT : 'transparent'}`, borderRadius: 24, padding: 12 }}>
          <div style={{ aspectRatio: '3 / 4', position: 'relative', background: '#fff', border: `1px solid ${BORDER}` }}>
            <OfficePageThumbnail page={page} load={loadThumbnail} enabled={!lockReason && !state.composing} />
            <button className="pdfe-thumb-hit" aria-label={`${page + 1} 페이지 선택`} aria-pressed={gridPage === page} disabled={!!lockReason} onClick={() => setGridPage(page)} onDoubleClick={() => void openGridPage(page)} />
            <div className="pdfe-page-controls"><button aria-label={`${page + 1} 페이지 열기`} disabled={!!lockReason} onClick={() => void openGridPage(page)}>열기</button></div>
          </div>
          <div style={{ textAlign: 'center', fontSize: 12, marginTop: 8 }}>{page + 1}</div>
        </div>)}
      </div>
      <div style={{ padding: 20, fontSize: 13, color: TEXT_MUTED, textAlign: 'center' }}>페이지를 선택한 뒤 열기를 누르세요 · 더블클릭하면 페이지로 이동합니다</div>
    </div>}
  </div>;
}

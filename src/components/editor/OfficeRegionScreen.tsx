import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CompositionEvent, PointerEvent, WheelEvent } from 'react';
import type { EditController } from '../../types/pdfEditor';
import type { OfficeFormat } from '../../documents/formats';
import type { OfficeSession, OfficeState } from '../../documents/officeTypes';
import { REGION_ROLE_LABELS } from '../../documents/regionTypes';
import type { OfficeRegionTarget, RegionConfig, RegionMapping, RegionRole } from '../../documents/regionTypes';
import { randomUUID } from '../../utils/crypto';
import { ACCENT, BORDER, CANVAS_BG, DANGER, SURFACE, TEXT, TEXT_MUTED } from '../../styles/theme';
import { DocumentHeader } from './DocumentHeader';

interface Props {
  session: OfficeSession;
  mount: HTMLElement;
  fileName: string;
  format: Exclude<OfficeFormat, 'pptx'>;
  config: RegionConfig;
  busy: boolean;
  saveLabel: string;
  saveError: string | null;
  onFileNameChange: (name: string) => void;
  onHome: () => void;
  onExport: () => void;
  onRetrySave: () => void;
  onError: (message: string) => void;
  onConfigChange: (config: RegionConfig) => void;
  onUnappliedEditChange: (dirty: boolean) => void;
  registerEditController: (controller: EditController | null) => void;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const intersects = (a: OfficeRegionTarget['boxes'][number], b: OfficeRegionTarget['boxes'][number]) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const hit = (target: OfficeRegionTarget, box: OfficeRegionTarget['boxes'][number]) => target.boxes.some(other => intersects(other, box));
const containsPoint = (box: OfficeRegionTarget['boxes'][number], x: number, y: number) =>
  x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;

export function OfficeRegionScreen(p: Props) {
  const [state, setState] = useState<OfficeState>(() => p.session.getState());
  const [targets, setTargets] = useState<OfficeRegionTarget[]>([]);
  const [role, setRole] = useState<RegionRole | 'locked'>('studentName');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [rectangle, setRectangle] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [pointerTool, setPointerTool] = useState<'select' | 'pan'>('select');
  const [ready, setReady] = useState(false);
  const placeholder = useRef<HTMLDivElement>(null);
  const config = useRef(p.config);
  const latest = useRef(p);
  latest.current = p;
  config.current = p.config;
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const draftsRef = useRef<Record<string, string>>({});
  const composing = useRef(new Set<string>());
  const dirty = useRef(new Set<string>());
  const worker = useRef<Promise<void> | null>(null);
  const failures = useRef<Record<string, string>>({});
  const generation = useRef(0);
  const mounted = useRef(true);
  const resolvedGeneration = useRef(0);
  const resolvedViewport = useRef<{ revision: number; renderRevision: number; zoom: number; epoch: number; rect: [number, number, number, number] } | null>(null);
  const gesture = useRef<{ pointerId: number; x: number; y: number; clientX: number; clientY: number; revision: number; renderRevision: number; viewportEpoch: number; geometry: number } | null>(null);
  const scrolling = useRef<Promise<void>>(Promise.resolve());
  const [viewportEpoch, setViewportEpoch] = useState(0);
  const viewportEpochRef = useRef(viewportEpoch);
  viewportEpochRef.current = viewportEpoch;
  const region = p.session.region;
  const locatorList = p.config.mappings.map(mapping => mapping.anchor.kind === 'pdf' ? '' : mapping.anchor.locator);
  const mappingUnresolved = targets.length !== p.config.mappings.length || p.config.mappings.some((mapping, index) =>
    !targets[index] || !!targets[index].reason || targets[index].locator !== locatorList[index] || targets[index].text !== mapping.currentText);
  const unresolved = p.config.reviewed && mappingUnresolved;
  const unresolvedReason = unresolved ? '저장된 영역의 원본 위치나 값이 달라졌습니다. 이 문서는 잠겨 있습니다. 매핑 수정에서 원본 대상을 다시 지정해 주세요.' : '';

  const updateConfig = (next: RegionConfig) => { config.current = next; latest.current.onConfigChange(next); };
  const report = (error: unknown) => latest.current.onError(message(error));
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const session = latest.current.session;
    if (!session.region) return;
    try {
      const locators = config.current.mappings.map(mapping => mapping.anchor.kind === 'pdf' ? '' : mapping.anchor.locator);
      const before = session.getState();
      const beforeBounds = placeholder.current?.getBoundingClientRect();
      const beforeEpoch = viewportEpochRef.current;
      const results = locators.length ? await session.region.targets(locators) : [];
      if (mounted.current && current === generation.current && latest.current.session === session) {
        const after = session.getState();
        const afterBounds = placeholder.current?.getBoundingClientRect();
        if (before.revision !== after.revision || before.pageView?.renderRevision !== after.pageView?.renderRevision
          || before.zoom !== after.zoom || beforeEpoch !== viewportEpochRef.current
          || !beforeBounds || !afterBounds
          || [beforeBounds.left, beforeBounds.top, beforeBounds.width, beforeBounds.height].some((value, index) =>
            value !== [afterBounds.left, afterBounds.top, afterBounds.width, afterBounds.height][index])) {
          setTargets([]);
          setViewportEpoch(epoch => epoch + 1);
          return;
        }
        const bounds = beforeBounds;
        resolvedViewport.current = { revision: before.revision, renderRevision: before.pageView?.renderRevision ?? 0,
          zoom: before.zoom, epoch: beforeEpoch, rect: [bounds.left, bounds.top, bounds.width, bounds.height] };
        resolvedGeneration.current = current;
        setTargets(results);
      }
    } catch (error) { if (mounted.current && current === generation.current) { setTargets([]); report(error); } }
  }, []);

  useLayoutEffect(() => { setState(p.session.getState()); return p.session.subscribe(setState); }, [p.session]);
  useLayoutEffect(() => {
    const element = placeholder.current;
    if (!element) return;
    let previous: { left: number; top: number; width: number; height: number } | null = null;
    const position = () => {
      const rect = element.getBoundingClientRect();
      const changed = !!previous && (rect.left !== previous.left || rect.top !== previous.top
        || rect.width !== previous.width || rect.height !== previous.height);
      previous = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      Object.assign(p.mount.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${Math.max(1, rect.width)}px`, height: `${Math.max(1, rect.height)}px`, visibility: 'visible', zIndex: '10' });
      if (changed) { generation.current++; setTargets([]); setViewportEpoch(value => value + 1); }
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(element);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      resize.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true);
      p.mount.inert = true;
      Object.assign(p.mount.style, { left: '-100000px', top: '0px', visibility: 'hidden', zIndex: '-1' });
    };
  }, [p.mount]);
  useEffect(() => {
    let active = true;
    p.mount.inert = true;
    setReady(false);
    if (!region) { p.onError('이 문서 엔진은 네이티브 영역 편집을 지원하지 않습니다.'); return; }
    void region.setMode(p.config.reviewed ? 'protected' : 'mapping').then(() => {
      if (!active) return;
      p.mount.inert = p.config.reviewed || p.busy;
      setReady(true);
      void refresh();
    }).catch(error => { if (active) p.onError(message(error)); });
    return () => { active = false; p.mount.inert = true; };
  }, [p.session, region, p.config.reviewed, p.mount, refresh]);
  useEffect(() => { if (ready && region) void refresh(); }, [ready, region, p.config.mappings, state.revision, state.pageView?.renderRevision, state.zoom, viewportEpoch, refresh]);
  useEffect(() => { if (ready) p.mount.inert = p.config.reviewed || p.busy; }, [ready, p.mount, p.busy, p.config.reviewed]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; gesture.current = null; };
  }, []);

  const setDirty = () => { if (mounted.current) latest.current.onUnappliedEditChange(dirty.current.size > 0 || composing.current.size > 0 || !!worker.current); };
  const setError = (id: string, reason: string) => {
    failures.current[id] = reason;
    if (mounted.current) setErrors(old => ({ ...old, [id]: reason }));
  };
  const process = () => {
    if (worker.current || !region) return;
    const session = p.session;
    const pending = (async () => {
      while (dirty.current.size && latest.current.session === session) {
        const id = [...dirty.current].find(candidate => !composing.current.has(candidate));
        if (!id) break;
        dirty.current.delete(id);
        const currentConfig = config.current;
        const mapping = currentConfig.mappings.find(item => item.id === id);
        const value = draftsRef.current[id];
        if (!mapping || mapping.role === 'locked' || mapping.anchor.kind === 'pdf' || !currentConfig.reviewed || value === undefined) continue;
        if (value === mapping.currentText) { setError(id, ''); continue; }
        if (session.getState().busy) { dirty.current.add(id); setError(id, '문서 엔진의 다른 작업이 끝난 뒤 다시 입력해 주세요.'); break; }
        const locators = currentConfig.mappings.map(item => item.anchor.kind === 'pdf' ? '' : item.anchor.locator);
        try {
          const fresh = await region.targets(locators);
          if (latest.current.session !== session || !config.current.reviewed
            || config.current.mappings.length !== currentConfig.mappings.length
            || config.current.mappings.some((item, index) => item.id !== currentConfig.mappings[index].id
              || item.role !== currentConfig.mappings[index].role || item.currentText !== currentConfig.mappings[index].currentText
              || item.anchor.kind === 'pdf' || item.anchor.locator !== locators[index])) {
            throw new Error('네이티브 편집 전에 문서나 보호 설정이 변경되었습니다.');
          }
          if (fresh.length !== locators.length || fresh.some((target, index) => target.reason || target.locator !== locators[index] || target.text !== currentConfig.mappings[index].currentText)) {
            dirty.current.add(id); setError(id, '원본 위치 또는 값이 바뀌어 편집을 적용할 수 없습니다.'); break;
          }
          const index = currentConfig.mappings.findIndex(item => item.id === id);
          if (fresh[index].boxes.some(box => currentConfig.mappings.some((item, lockedIndex) => item.role === 'locked'
            && fresh[lockedIndex].boxes.some(locked => intersects(box, locked))))) {
            dirty.current.add(id); setError(id, '잠긴 원본 영역과 실제 편집 범위가 겹쳐 적용하지 않았습니다.'); break;
          }
          const revision = session.getState().revision;
          const result = await region.replace(mapping.anchor.locator, mapping.currentText, value, revision, locators);
          if (latest.current.session !== session) return;
          if (!result.ok) { dirty.current.add(id); setError(id, result.reason); break; }
          if (result.targets.some(target => target.reason)) {
            dirty.current.add(id); setError(id, '변경 후 원본 영역의 위치를 확인하지 못했습니다.'); break;
          }
          const latestConfig = config.current;
          if (!latestConfig.reviewed || latestConfig.mappings.length !== currentConfig.mappings.length
            || latestConfig.mappings.some((item, index) => item.id !== currentConfig.mappings[index].id
              || item.role !== currentConfig.mappings[index].role || item.currentText !== currentConfig.mappings[index].currentText
              || item.anchor.kind === 'pdf' || item.anchor.locator !== locators[index])) {
            throw new Error('편집 중 영역 역할이나 값이 변경되었습니다. 매핑을 다시 확인해 주세요.');
          }
          const next = { ...latestConfig, mappings: currentConfig.mappings.map((item, index) => ({
            ...item, anchor: item.anchor.kind === 'pdf' ? item.anchor : { ...item.anchor, locator: result.targets[index].locator },
            currentText: result.targets[index].text,
          })) };
          updateConfig(next);
          setTargets(result.targets);
          setError(id, '');
          if (draftsRef.current[id] !== value) dirty.current.add(id);
        } catch (error) { dirty.current.add(id); setError(id, message(error)); break; }
      }
    })();
    worker.current = pending;
    setDirty();
    void pending.finally(() => {
      if (worker.current === pending) worker.current = null;
      if (!mounted.current) return;
      setDirty();
      if ([...dirty.current].some(id => !failures.current[id] && !composing.current.has(id))) process();
    });
  };
  const changeDraft = (id: string, value: string, composingNow = false) => {
    draftsRef.current[id] = value;
    setDrafts(old => ({ ...old, [id]: value }));
    dirty.current.add(id);
    setError(id, '');
    setDirty();
    if (!composingNow) process();
  };
  const flush = useCallback(async () => {
    if (composing.current.size) { latest.current.onError('입력 조합이 끝난 뒤 다시 시도해 주세요.'); return false; }
    while (dirty.current.size || worker.current) {
      if ([...dirty.current].some(id => !!failures.current[id])) return false;
      if (!worker.current) process();
      const current = worker.current;
      if (!current) break;
      await current;
    }
    return dirty.current.size === 0 && !worker.current && composing.current.size === 0;
  }, [region, p.session]);
  const afterFlush = async (action: () => Promise<unknown> | void) => {
    if (!await flush()) { latest.current.onError('작성 중인 영역 값을 먼저 확인해 주세요.'); return; }
    try { await action(); } catch (error) { report(error); }
  };
  const zoomTo = (value: number) => void afterFlush(async () => {
    const result = await p.session.execute({ type: 'zoom', value });
    if (!result.ok) throw new Error(result.reason);
    generation.current++; setTargets([]); setViewportEpoch(epoch => epoch + 1);
  });
  useEffect(() => {
    const controller: EditController = { flush, cancel: () => { gesture.current = null; setRectangle(null); } };
    p.registerEditController(controller);
    return () => p.registerEditController(null);
  }, [flush, p.registerEditController]);

  const capture = async () => {
    if (!region || !ready || p.busy) return;
    try {
      const captured = await region.capture();
      if (!mounted.current || latest.current.session !== p.session) return;
      if (!captured) { p.onError('원본에서 선택한 글자나 빈 셀 안의 커서를 확인해 주세요.'); return; }
      if (captured.reason) { p.onError(captured.reason); return; }
      const current = config.current;
      const existing = current.mappings.find(item => item.anchor.kind !== 'pdf' && item.anchor.locator === captured.locator);
      const added: RegionMapping = { id: existing?.id ?? randomUUID(), role, anchor: { kind: p.format, locator: captured.locator, originalText: captured.text }, currentText: captured.text };
      const mappings = existing ? current.mappings.map(item => item.id === existing.id ? { ...added, anchor: existing.anchor } : item) : [...current.mappings, added];
      const selectedIds = role === 'locked' ? current.selectedIds.filter(id => id !== added.id) : current.selectedIds;
      updateConfig({ ...current, mappings, selectedIds, reviewed: false });
      setAcknowledged(false);
      await refresh();
    } catch (error) { report(error); }
  };
  const roleChange = (id: string, value: RegionRole | 'locked') => {
    const current = config.current;
    updateConfig({ ...current, reviewed: false, selectedIds: value === 'locked' ? current.selectedIds.filter(item => item !== id) : current.selectedIds,
      mappings: current.mappings.map(item => item.id === id ? { ...item, role: value } : item) });
    setAcknowledged(false);
  };
  const select = (ids: string[]) => {
    const current = config.current;
    const eligible = ids.filter(id => {
      const index = current.mappings.findIndex(item => item.id === id && item.role !== 'locked');
      return index >= 0 && targetsRef.current[index] && !targetsRef.current[index].reason && targetsRef.current[index].text === current.mappings[index].currentText
        && !current.mappings.some((item, lockedIndex) => item.role === 'locked'
          && targetsRef.current[lockedIndex]?.boxes.some(box => hit(targetsRef.current[index], box)));
    });
    if (eligible.length) updateConfig({ ...current, selectedIds: [...new Set([...current.selectedIds, ...eligible])] });
  };
  const scrollNative = (dx: number, dy: number) => {
    if (!region || !ready) return;
    generation.current++;
    setTargets([]);
    scrolling.current = scrolling.current.catch(() => undefined).then(async () => {
      await region.scroll(dx, dy);
      await refresh();
    });
    void scrolling.current.catch(report);
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready || !p.config.reviewed || p.busy || event.button !== 0
      || (pointerTool === 'select' && (unresolved || resolvedGeneration.current !== generation.current))) return;
    const rect = event.currentTarget.getBoundingClientRect();
    gesture.current = { pointerId: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top,
      clientX: event.clientX, clientY: event.clientY, revision: state.revision,
      renderRevision: state.pageView?.renderRevision ?? 0, viewportEpoch, geometry: generation.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setRectangle(null);
    if (pointerTool === 'pan') return;
    if (start.revision !== p.session.getState().revision
      || start.renderRevision !== (p.session.getState().pageView?.renderRevision ?? 0)
      || start.viewportEpoch !== viewportEpoch || start.geometry !== generation.current
      || resolvedGeneration.current !== generation.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (Math.abs(x - start.x) < 3 && Math.abs(y - start.y) < 3) {
      const candidates = config.current.mappings.flatMap((mapping, index) =>
        mapping.role !== 'locked' && targetsRef.current[index]?.boxes.some(box => containsPoint(box, x, y)) ? [mapping.id] : []);
      if (candidates.length === 1) select(candidates);
      else if (candidates.length > 1) p.onError('겹친 원본 영역을 한 항목으로 구분할 수 없습니다. 사각형으로 각각 선택해 주세요.');
      return;
    }
    const box = { x: Math.min(x, start.x), y: Math.min(y, start.y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
    select(config.current.mappings.flatMap((mapping, index) =>
      mapping.role !== 'locked' && targetsRef.current[index]?.boxes.some(candidate => intersects(candidate, box)) ? [mapping.id] : []));
  };
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!region || !ready || !p.config.reviewed) return;
    event.preventDefault();
    gesture.current = null;
    setRectangle(null);
    const delta = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 600 : 1;
    scrollNative(event.deltaX * delta, event.deltaY * delta);
  };
  const navigate = async (page: number) => {
    if (!p.session.pageView || !state.pageView || page < 0 || page >= state.pageView.pageCount || !await flush()) return;
    generation.current++;
    setTargets([]);
    try {
      const result = await p.session.pageView.execute({ type: 'goToPage', page });
      if (!result.ok) p.onError(result.reason); else setViewportEpoch(value => value + 1);
    } catch (error) { report(error); }
  };
  const endComposition = (id: string, event: CompositionEvent<HTMLTextAreaElement>) => {
    composing.current.delete(id);
    changeDraft(id, event.currentTarget.value);
  };

  const cards = p.config.mappings.filter(mapping => p.config.selectedIds.includes(mapping.id));
  return <div data-screen-label="영역 편집" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', color: TEXT }}>
    <DocumentHeader fileName={p.fileName} format={p.format} busy={p.busy}
      saveLabel={dirty.current.size || worker.current || composing.current.size
        ? '원본에 적용되지 않은 입력' : p.saveLabel}
      saveError={p.saveError} onFileNameChange={p.onFileNameChange} onHome={p.onHome} onExport={p.onExport} onRetrySave={p.onRetrySave} />
    <div className="pdfe-region-toolbar" style={{ padding: '8px 16px', borderBottom: `1px solid ${BORDER}`, background: SURFACE, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {p.config.reviewed && <span role="group" aria-label="원본 보기 도구">
        <button aria-pressed={pointerTool === 'select'} onClick={() => setPointerTool('select')}>영역 선택</button>
        <button aria-pressed={pointerTool === 'pan'} onClick={() => setPointerTool('pan')}>손 도구</button>
      </span>}
      <strong>{p.config.reviewed ? '보호된 영역 편집' : '원본 영역 역할 확인'}</strong>
      <span style={{ color: TEXT_MUTED, fontSize: 12 }}>원본 파일은 왼쪽에 표시됩니다. 지정하지 않은 영역은 영역 편집에서 잠겨 있습니다.</span>
      {state.pageView && <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        <button disabled={p.busy || state.pageView.currentPage === 0} onClick={() => void navigate(state.pageView!.currentPage - 1)}>이전 쪽</button>
        {state.pageView.currentPage + 1} / {state.pageView.pageCount}
        <button disabled={p.busy || state.pageView.currentPage + 1 >= state.pageView.pageCount} onClick={() => void navigate(state.pageView!.currentPage + 1)}>다음 쪽</button>
      </span>}
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button disabled={p.busy || state.zoom <= .25} onClick={() => zoomTo(Math.max(.25, Math.round(state.zoom * 100 - 10) / 100))}>축소</button>
        {Math.round(state.zoom * 100)}%
        <button disabled={p.busy || state.zoom >= 4} onClick={() => zoomTo(Math.min(4, Math.round(state.zoom * 100 + 10) / 100))}>확대</button>
        <button disabled={p.busy || !p.session.pageView} onClick={() => void afterFlush(async () => {
          const result = await p.session.pageView!.execute({ type: 'fitWidth' });
          if (!result.ok) throw new Error(result.reason);
          generation.current++; setTargets([]); setViewportEpoch(epoch => epoch + 1);
        })}>폭 맞춤</button>
      </span>
    </div>
    <div className="pdfe-region-layout" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div ref={placeholder} className="pdfe-region-source" style={{ position: 'relative', flex: 1, minWidth: 0, background: CANVAS_BG, overflow: 'hidden' }}>
        {p.config.reviewed && <div aria-label="원본 영역 선택" onPointerDown={pointerDown}
          onPointerMove={event => {
            const start = gesture.current;
            if (!start || start.pointerId !== event.pointerId) return;
            if (pointerTool === 'pan') {
              const dx = start.clientX - event.clientX, dy = start.clientY - event.clientY;
              start.clientX = event.clientX; start.clientY = event.clientY;
              if (dx || dy) scrollNative(dx, dy);
              return;
            }
            const bounds = event.currentTarget.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
            setRectangle({ x: Math.min(x, start.x), y: Math.min(y, start.y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) });
          }} onPointerUp={pointerUp} onPointerCancel={() => { gesture.current = null; setRectangle(null); }} onWheel={wheel}
          style={{ position: 'absolute', inset: 0, zIndex: 20, touchAction: 'none', cursor: pointerTool === 'pan' ? 'grab' : 'crosshair' }}>
          {targets.map((target, index) => target.boxes.map((box, number) => <div key={`${index}:${number}`} aria-hidden="true"
            style={{ position: 'absolute', left: box.x, top: box.y, width: box.width, height: box.height,
              outline: p.config.selectedIds.includes(p.config.mappings[index]?.id) ? `2px solid ${ACCENT}` : undefined,
              background: p.config.mappings[index]?.role === 'locked' ? 'rgba(192,54,44,.12)' : undefined, pointerEvents: 'none' }} />))}
          {rectangle && <div aria-hidden="true" style={{ position: 'absolute', left: rectangle.x, top: rectangle.y,
            width: rectangle.width, height: rectangle.height, border: `1px solid ${ACCENT}`, background: 'rgba(30,105,185,.13)', pointerEvents: 'none' }} />}
        </div>}
      </div>
      <aside aria-label="영역 편집 카드" className="pdfe-region-cards" style={{ width: 360, maxWidth: '48%', flexShrink: 0, overflowY: 'auto', padding: 16, background: SURFACE, borderLeft: `1px solid ${BORDER}` }}>
        {!region && <p role="alert">이 문서 엔진의 원본 영역 편집을 사용할 수 없습니다.</p>}
        {!p.config.reviewed && <>
          <p>왼쪽 원본에서 값 글자를 선택하거나 빈 값 셀 안에 커서를 놓은 다음 역할을 지정하세요. 출결표·교사 확인은 선택하지 않거나 잠금으로 표시하세요.</p>
          <label>선택 영역 역할 <select aria-label="선택 영역 역할" value={role} onChange={event => setRole(event.target.value as RegionRole | 'locked')}>
            {Object.entries(REGION_ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            <option value="locked">출결·교사 확인 등 잠금</option>
          </select></label>
          <button disabled={!ready || !region || p.busy} onClick={() => void capture()}>원본 선택 영역 지정</button>
          {p.config.mappings.map(mapping => <div key={mapping.id} style={{ marginTop: 12, padding: 8, border: `1px solid ${BORDER}`, overflowWrap: 'anywhere' }}>
            <span>{mapping.currentText || '(빈 영역)'}</span>
            <select aria-label="영역 역할 수정" value={mapping.role} onChange={event => roleChange(mapping.id, event.target.value as RegionRole | 'locked')}>
              {Object.entries(REGION_ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              <option value="locked">잠금</option>
            </select>
            <button onClick={() => { const current = config.current; updateConfig({ ...current, mappings: current.mappings.filter(item => item.id !== mapping.id), selectedIds: current.selectedIds.filter(id => id !== mapping.id) }); }}>매핑 해제</button>
          </div>)}
          <label style={{ display: 'block', marginTop: 14 }}><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /> 출결표와 교사 확인을 확인했으며, 편집 대상으로 지정하지 않은 영역은 잠겨 있음을 이해했습니다.</label>
          <button disabled={!ready || mappingUnresolved || resolvedGeneration.current !== generation.current
            || !acknowledged || !p.config.mappings.some(item => item.role !== 'locked') || p.busy}
            onClick={() => updateConfig({ ...config.current, reviewed: true })}>역할 확인 후 영역 편집 시작</button>
          {mappingUnresolved && p.config.mappings.length > 0 && <p role="alert" style={{ color: DANGER }}>원본 범위를 다시 확인할 수 없는 매핑이 있습니다. 해당 항목을 재지정하거나 해제한 뒤 확인해 주세요.</p>}
        </>}
        {p.config.reviewed && <>
          <p>끌어서 겹치는 지정 영역을 모두 추가합니다. 클릭도 개별 영역을 추가합니다. 다른 영역은 원본 그대로 잠겨 있습니다.</p>
          <button onClick={() => void afterFlush(() => updateConfig({ ...config.current, reviewed: false }))}>매핑 수정</button>
          <button disabled={!p.config.selectedIds.length} onClick={() => void afterFlush(() => updateConfig({ ...config.current, selectedIds: [] }))}>모두 해제</button>
          {unresolvedReason && <p role="alert" style={{ color: DANGER }}>{unresolvedReason}</p>}
          {cards.map(mapping => <div key={mapping.id} style={{ marginTop: 14, padding: 10, border: `1px solid ${BORDER}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <button onClick={() => void afterFlush(() => {
                const current = config.current.mappings.find(item => item.id === mapping.id);
                if (!current || current.anchor.kind === 'pdf') return;
                void region?.highlight(current.anchor.locator).then(result => {
                  if (!result.ok) latest.current.onError(result.reason);
                  else { generation.current++; setTargets([]); void refresh(); }
                }).catch(report);
              })}>{REGION_ROLE_LABELS[mapping.role as RegionRole]} · 원본에서 보기</button>
              <button onClick={() => void afterFlush(() => updateConfig({ ...config.current, selectedIds: config.current.selectedIds.filter(id => id !== mapping.id) }))}>해제</button>
            </div>
            <textarea aria-label={`${REGION_ROLE_LABELS[mapping.role as RegionRole]} 값`} rows={mapping.role === 'opinion' ? 5 : 2}
              disabled={!!unresolvedReason || (p.busy && !composing.current.has(mapping.id)) || mapping.role === 'locked'}
              value={drafts[mapping.id] ?? mapping.currentText}
              onChange={event => changeDraft(mapping.id, event.target.value, composing.current.has(mapping.id))}
              onCompositionStart={() => { composing.current.add(mapping.id); setDirty(); }}
              onCompositionEnd={event => endComposition(mapping.id, event)}
              onKeyDown={event => { if (event.nativeEvent.isComposing) return; event.stopPropagation(); }}
              style={{ width: '100%', boxSizing: 'border-box', font: 'inherit', minHeight: 54 }} />
            {errors[mapping.id] && <p role="alert" style={{ color: DANGER }}>{errors[mapping.id]}</p>}
          </div>)}
          {!cards.length && <p>선택한 영역이 없습니다.</p>}
        </>}
      </aside>
    </div>
  </div>;
}

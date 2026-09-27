import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, MutableRefObject } from 'react';
import type { EditableTextTarget, RenderedPage, SourceFontInfo, SourceTextLine, SourceTextPage } from '../../../pdf/engineTypes';
import type { DownloadedFontAsset, FontChoice, Page, TextContent } from '../../../types/pdfEditor';
import type { RegionConfig, RegionMapping, RegionRole } from '../../../documents/regionTypes';
import { REGION_ROLE_LABELS } from '../../../documents/regionTypes';
import { applyRunStyle, normalizeInput, plainText, reconcileInput } from '../../../pdf/textEditing';
import { buildSourceTextGroup } from '../../../pdf/sourceTextGroups';
import type { InputAnchor } from '../../../pdf/textEditing';
import { ACCENT, BORDER, CANVAS_BG, SURFACE } from '../../../styles/theme';
import { DocumentHeader } from '../../editor/DocumentHeader';
import { PdfPageSurface } from './PdfPageSurface';
import type { EditorScreenProps } from './EditorScreen';

type Props = EditorScreenProps & { regionConfig: RegionConfig; onRegionChange: (next: RegionConfig) => void };
type SourceTarget = Extract<EditableTextTarget, { kind: 'source' }>;
type PdfPage = Extract<Page, { kind: 'pdf' }>;
const keyOf = (pageId: string, lineIds: readonly string[]) => JSON.stringify([pageId, lineIds]);
const intersects = (a: readonly number[], b: readonly number[]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const glyphBoxes = (line: SourceTextLine) => line.chars.map(char => char.paintBounds ?? [
  Math.min(char.quad[0], char.quad[2], char.quad[4], char.quad[6]),
  Math.min(char.quad[1], char.quad[3], char.quad[5], char.quad[7]),
  Math.max(char.quad[0], char.quad[2], char.quad[4], char.quad[6]),
  Math.max(char.quad[1], char.quad[3], char.quad[5], char.quad[7]),
]);
const sourceOriginalText = (source: SourceTextPage, lineIds: readonly string[]) =>
  lineIds.map(id => source.lines.find(line => line.lineId === id)?.text ?? '').join('\n');
const mappedTarget = (mapping: RegionMapping, page: PdfPage, target: SourceTarget, source: SourceTextPage) => mapping.anchor.kind === 'pdf'
  && mapping.anchor.pageId === page.id && mapping.anchor.sourcePageIndex === page.sourcePageIndex
  && mapping.anchor.lineIds.length === target.lineIds.length
  && mapping.anchor.lineIds.every((id, index) => id === target.lineIds[index])
  && mapping.anchor.originalText === sourceOriginalText(source, target.lineIds);

function resolveTarget(page: PdfPage, line: SourceTextLine, render: RenderedPage, source: SourceTextPage, lineIds?: string[]): SourceTarget {
  const ids = lineIds ?? page.textEdits.find(edit => edit.lineIds.includes(line.lineId))?.lineIds ?? [line.lineId];
  if (ids.length > 1) {
    try {
      const group = buildSourceTextGroup(page, source, ids);
      const edit = page.textEdits.find(item => item.lineIds.length === ids.length && item.lineIds.every((id, index) => id === ids[index]));
      return { kind: 'source', ...group, content: edit?.content ?? group.content, widthPt: edit?.widthPt ?? group.widthPt,
        layout: edit?.layout ?? group.layout, editable: true };
    } catch (error) {
      return { kind: 'source', lineIds: ids, bounds: line.bounds, quads: [], content: line.content, widthPt: line.widthPt,
        editable: false, reason: error instanceof Error ? error.message : '원본 묶음의 위치를 확인할 수 없습니다.' };
    }
  }
  const matches = render.textTargets.filter(target => target.kind === 'source' && target.lineIds.length === 1 && target.lineIds[0] === line.lineId);
  const target = matches.length === 1 ? matches[0] as SourceTarget : undefined;
  if (!target) return { kind: 'source', lineIds: [line.lineId], bounds: line.bounds, quads: line.chars.map(char => char.quad),
    content: line.content, widthPt: line.widthPt, editable: false, reason: '원본 텍스트 위치를 확인할 수 없습니다.' };
  return target;
}

export function eligibility(page: PdfPage, line: SourceTextLine, target: SourceTarget, source: SourceTextPage, config: RegionConfig, render?: RenderedPage): string | null {
  const owners = config.mappings.filter(mapping => mappedTarget(mapping, page, target, source));
  if (owners.length !== 1 || owners[0].role === 'locked') return '역할이 지정되지 않았거나 잠긴 원본 영역입니다.';
  if (target.lineIds.some(id => !source.lines.find(member => member.lineId === id)?.editable) || !target.editable)
    return target.reason || line.reason || '이 원본 영역은 안전하게 편집할 수 없습니다.';
  if (owners[0].currentText !== plainText(target.content)) return '원본 줄의 내용이 확인된 값과 달라 다시 검토해야 합니다.';
  const selectedBoxes = page.textEdits.some(edit => edit.lineIds.some(id => target.lineIds.includes(id))) ? [target.bounds]
    : target.lineIds.flatMap(id => glyphBoxes(source.lines.find(member => member.lineId === id)!));
  for (const other of source.lines) {
    if (target.lineIds.includes(other.lineId)) continue;
    const mappings = config.mappings.filter(mapping => mapping.anchor.kind === 'pdf' && mapping.anchor.pageId === page.id
      && mapping.anchor.sourcePageIndex === page.sourcePageIndex && mapping.anchor.lineIds.includes(other.lineId));
    if (mappings.length === 1 && mappings[0].role !== 'locked') continue;
    const boxes = glyphBoxes(other);
    const currentEdit = page.textEdits.find(edit => edit.lineIds.includes(other.lineId));
    if (currentEdit) {
      const matches = render?.textTargets.filter(item => item.lineIds.includes(other.lineId));
      if (matches?.length !== 1) return '잠긴 원본 줄의 현재 위치를 확인할 수 없습니다.';
      boxes.push(matches[0].bounds);
    }
    if (selectedBoxes.some(box => boxes.some(otherBox => intersects(box, otherBox)))) return '잠긴 원본 텍스트와 겹쳐 편집할 수 없습니다.';
  }
  return null;
}

interface CardProps {
  page: PdfPage; line: SourceTextLine; target: SourceTarget; mapping: RegionMapping; reason: string | null; sourceFonts?: SourceFontInfo[];
  latest: MutableRefObject<Props>; registerPending: (promise: Promise<boolean>) => void;
  runExclusive: (action: () => Promise<boolean>) => Promise<boolean>; allowDrain: MutableRefObject<boolean>;
  onCompositionActive: (active: boolean) => void; onInvalid: (invalid: boolean) => void; onRelease: () => void; onHighlight: () => void;
}
function RegionCard(props: CardProps) {
  const { page, line, target, mapping, reason, latest, registerPending, runExclusive, allowDrain, onCompositionActive, onInvalid, onRelease, onHighlight } = props;
  const [content, setContent] = useState<TextContent>(target.content);
  const contentRef = useRef(content);
  const [compositionText, setCompositionText] = useState<string | null>(null);
  const composingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [fontFailure, setFontFailure] = useState(false);
  const [proposal, setProposal] = useState<FontChoice | null>(null);
  const [fontBusy, setFontBusy] = useState(false);
  const fontAssets = useRef<DownloadedFontAsset[]>([]);
  const anchor = useRef<InputAnchor | null>(null);
  const confirmed = useRef({ text: mapping.currentText, revision: latest.current.getDocumentState().revision });
  const queued = useRef<TextContent | null>(null);
  const running = useRef(false);
  const history = useRef<{ undo: TextContent[]; redo: TextContent[] }>({ undo: [], redo: [] });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onCompositionActive(false); onInvalid(false); }; }, []);
  useEffect(() => {
    if (running.current || queued.current || composingRef.current) return;
    const state = latest.current.getDocumentState();
    const actual = state.workspace?.pages.find(item => item.id === page.id);
    const edit = actual?.kind === 'pdf' ? actual.textEdits.find(item => item.lineIds.length === target.lineIds.length && item.lineIds.every((id, index) => id === target.lineIds[index])) : undefined;
    const text = plainText(edit?.content ?? target.content);
    if (!error && plainText(contentRef.current) === confirmed.current.text && text === mapping.currentText
      && state.revision !== confirmed.current.revision) {
      confirmed.current = { text, revision: state.revision };
      contentRef.current = edit?.content ?? target.content;
      setContent(contentRef.current);
    }
  }, [latest, mapping.currentText, page.id, target, error, latest.current.revision]);

  async function commit(snapshot: TextContent): Promise<boolean> {
    const p = latest.current;
    const source = await p.engine.text(page.sourcePageIndex);
    const state = p.getDocumentState();
    const current = state.workspace?.pages.find(item => item.id === page.id);
    const original = source.lines.find(item => item.lineId === target.lineIds[0]);
    const region = state.workspace?.region;
    const owner = region?.mappings.find(item => item.id === mapping.id);
    if (!region?.reviewed || (p.isExporting && !allowDrain.current) || !p.engine.info?.canEdit
      || current?.kind !== 'pdf' || current.sourcePageIndex !== page.sourcePageIndex || !original || !owner
      || !mappedTarget(owner, current, target, source)) throw new Error('원본 영역 또는 편집 권한이 변경되었습니다.');
    const currentEdit = current.textEdits.find(edit => edit.lineIds.some(id => target.lineIds.includes(id)));
    if (currentEdit && (currentEdit.lineIds.length !== target.lineIds.length
      || currentEdit.lineIds.some((id, index) => id !== target.lineIds[index]))) throw new Error('다른 원본 묶음과 겹치는 영역은 편집할 수 없습니다.');
    const currentContent = currentEdit?.content ?? target.content;
    if (plainText(currentContent) !== owner.currentText) throw new Error('다른 변경으로 원본 영역의 값이 달라졌습니다.');
    const protectedEdit = current.textEdits.some(edit => edit.lineIds.some(id => {
      if (target.lineIds.includes(id)) return false;
      const owners = region.mappings.filter(item => item.anchor.kind === 'pdf' && item.anchor.pageId === page.id
        && item.anchor.lineIds.includes(id));
      return owners.length !== 1 || owners[0].role === 'locked';
    }));
    const currentRender = currentEdit || protectedEdit
      ? await p.engine.render(current, 96 / 72 * p.zoom * (window.devicePixelRatio || 1), state.revision, 0, 'active') : undefined;
    const resolved = currentRender ? resolveTarget(current, original, currentRender, source, target.lineIds) : target;
    const checked: SourceTarget = { ...resolved, content: currentContent, widthPt: currentEdit?.widthPt ?? resolved.widthPt,
      ...(currentEdit?.layout ? { layout: currentEdit.layout } : {}) };
    const blocked = eligibility(current, original, checked, source, region, currentRender);
    if (blocked) throw new Error(blocked);
    const nextText = plainText(snapshot);
    if (nextText === owner.currentText && JSON.stringify(snapshot) === JSON.stringify(currentContent)) return true;
    const edit = { lineIds: [...target.lineIds], content: snapshot, widthPt: checked.widthPt,
      ...(checked.layout ? { layout: checked.layout } : {}) };
    const candidate = { ...current, textEdits: [...current.textEdits.filter(item => !item.lineIds.some(id => target.lineIds.includes(id))), edit] };
    const result = await p.engine.validate(candidate, state.revision, state.revision + 1);
    if (!result.ok) {
      if (mounted.current) {
        setProposal(result.proposedFont ?? null);
        setFontFailure(result.code === 'FONT_SUBSTITUTION_REQUIRED');
      }
      throw new Error(result.message);
    }
    const now = p.getDocumentState();
    const finalRegion = now.workspace?.region;
    const finalOwner = finalRegion?.mappings.find(item => item.id === owner.id);
    if (now.revision !== state.revision || (latest.current.isExporting && !allowDrain.current)
      || latest.current.engine.sessionId !== p.engine.sessionId || !finalRegion?.reviewed
      || !finalOwner || finalOwner.role !== owner.role || !mappedTarget(finalOwner, current, target, source)
      || finalOwner.currentText !== owner.currentText) throw new Error('검증 중 문서 또는 보호 설정이 변경되었습니다.');
    const finalBlocked = eligibility(current, original, checked, source, finalRegion, currentRender);
    if (finalBlocked) throw new Error(finalBlocked);
    const referencedFonts = fontAssets.current.filter(asset => snapshot.runs.some(run =>
      run.style.font.kind === 'downloaded' && run.style.font.assetId === asset.id));
    latest.current.docActions.upsertRegionText(page.id, owner.id, edit, referencedFonts);
    const updated = latest.current.getDocumentState();
    if (updated.revision !== state.revision + 1 || updated.workspace?.region?.mappings.find(item => item.id === owner.id)?.currentText !== nextText)
      throw new Error('편집 권한이 변경되어 적용하지 않았습니다.');
    confirmed.current = { text: nextText, revision: updated.revision };
    if (mounted.current) { setProposal(null); setFontFailure(false); }
    return true;
  }
  function enqueue(next: TextContent) {
    queued.current = next;
    if (running.current) return;
    running.current = true;
    const task = (async () => {
      try {
        while (queued.current && mounted.current) {
          const snapshot = queued.current; queued.current = null;
          try { await runExclusive(() => commit(snapshot)); if (mounted.current) setError(null); }
          catch (failure) {
            if (queued.current) continue;
            if (mounted.current) {
              setError(failure instanceof Error ? failure.message : '원본 텍스트를 적용할 수 없습니다.');
              onInvalid(true);
            }
            return false;
          }
        }
        if (mounted.current) onInvalid(false);
        return true;
      } finally { running.current = false; }
    })();
    registerPending(task);
  }
  function change(next: TextContent, record = true) {
    if (reason || (latest.current.isExporting && !composingRef.current)) return;
    if (record) { history.current.undo.push(contentRef.current); history.current.redo = []; }
    contentRef.current = next; setContent(next); setError(null); setProposal(null); setFontFailure(false); onInvalid(false);
    if (!composingRef.current) enqueue(next);
  }
  function input(event: ChangeEvent<HTMLTextAreaElement>) {
    const element = event.currentTarget;
    if (composingRef.current) { setCompositionText(element.value); return; }
    if (normalizeInput(element.value).text === plainText(contentRef.current)) return;
    const captured = anchor.current ?? { start: element.selectionStart, end: element.selectionEnd, inputType: (event.nativeEvent as InputEvent).inputType || 'insertText' };
    anchor.current = null;
    change({ ...contentRef.current, runs: reconcileInput(contentRef.current.runs, captured, element.value) });
  }
  function key(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
    event.preventDefault(); event.stopPropagation();
    if (composingRef.current) return;
    const from = event.shiftKey ? history.current.redo : history.current.undo;
    const to = event.shiftKey ? history.current.undo : history.current.redo;
    const previous = from.pop();
    if (previous) { to.push(contentRef.current); change(previous, false); }
  }
  const sourceChoices = [...new Map([...target.content.runs, ...content.runs]
    .flatMap(run => run.style.font.kind === 'source'
      ? [[`${run.style.font.sourcePageIndex}:${run.style.font.fontKey}`, run.style.font] as const] : [])).values()];
  async function resolveFont(source: Extract<FontChoice, { kind: 'source' }>, file?: File) {
    if (fontBusy || composingRef.current || latest.current.isExporting) return;
    const session = latest.current.engine.sessionId;
    const workspaceId = latest.current.workspace.id;
    setFontBusy(true);
    try {
      const asset = file ? await latest.current.engine.importFont(source, file) : await latest.current.engine.downloadFont(source);
      if (!mounted.current || latest.current.engine.sessionId !== session || latest.current.workspace.id !== workspaceId) return;
      fontAssets.current = [...fontAssets.current.filter(item => item.id !== asset.id), asset];
      const snapshot = contentRef.current;
      const runs = snapshot.runs.map(run => run.style.font.kind === 'source'
        && run.style.font.sourcePageIndex === source.sourcePageIndex && run.style.font.fontKey === source.fontKey
        ? { ...run, style: { ...run.style, font: { kind: 'downloaded' as const, assetId: asset.id } } } : run);
      change({ ...snapshot, runs });
    } catch (failure) {
      if (mounted.current) { setError(failure instanceof Error ? failure.message : '원본 글꼴을 불러올 수 없습니다.'); onInvalid(true); }
    } finally { if (mounted.current) setFontBusy(false); }
  }
  return <article style={{ border: `1px solid ${reason ? BORDER : ACCENT}`, borderRadius: 10, padding: 12, background: SURFACE, display: 'grid', gap: 8 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><button type="button" onClick={onHighlight} style={{ flex: 1, textAlign: 'left' }}>{REGION_ROLE_LABELS[mapping.role as RegionRole]} · {page.label} · {line.text || '(빈 줄)'}</button><button type="button" onClick={onRelease}>선택 해제</button></div>
    {reason ? <p role="alert">{reason}</p> : <textarea aria-label={`${REGION_ROLE_LABELS[mapping.role as RegionRole]} 원본 텍스트`} value={compositionText ?? plainText(content)} disabled={latest.current.isExporting && !composingRef.current} onBeforeInput={event => { const el = event.currentTarget; if (!composingRef.current) anchor.current = { start: el.selectionStart, end: el.selectionEnd, inputType: (event.nativeEvent as InputEvent).inputType || 'insertText' }; }} onChange={input} onCompositionStart={event => { anchor.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd, inputType: 'insertCompositionText' }; composingRef.current = true; setCompositionText(event.currentTarget.value); onCompositionActive(true); }} onCompositionEnd={event => {
      const value = event.currentTarget.value;
      composingRef.current = false; setCompositionText(null); onCompositionActive(false);
      if (normalizeInput(value).text !== plainText(contentRef.current))
        change({ ...contentRef.current, runs: reconcileInput(contentRef.current.runs, anchor.current ?? { start: 0, end: plainText(contentRef.current).length, inputType: 'insertCompositionText' }, value) });
      anchor.current = null;
    }} onKeyDown={key} rows={2} style={{ width: '100%', resize: 'vertical' }} />}
    {error && <div role="alert">{error}</div>}
    {fontFailure && sourceChoices.length > 0 && error && <div aria-label="원본 글꼴 해결" style={{ display: 'grid', gap: 6 }}>
      {sourceChoices.map(source => {
        const info = props.sourceFonts?.find(candidate =>
          candidate.sourcePageIndex === source.sourcePageIndex && candidate.fontKey === source.fontKey);
        if (!info) return null;
        return <div key={`${source.sourcePageIndex}:${source.fontKey}`}>
          <strong>{info.declaredName}</strong> · {info.embedded === true ? '일부 문자만 포함된 원본 글꼴일 수 있습니다.' : '원본 글꼴을 사용할 수 없습니다.'}
          {info.catalogId ? <button type="button" disabled={fontBusy || composingRef.current || latest.current.isExporting}
            onClick={() => void resolveFont(source)}>{fontBusy ? '확인 중…' : '같은 얼굴의 공개 글꼴 다운로드해서 적용'}</button>
            : info.embedded !== 'unknown' && <label>원본과 이름·굵기가 일치하는 글꼴 파일 불러오기
              <input type="file" accept=".ttf,.otf,.ttc,font/ttf,font/otf,font/collection" disabled={fontBusy || composingRef.current || latest.current.isExporting}
                onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void resolveFont(source, file); }} />
            </label>}
        </div>;
      })}
    </div>}
    {fontFailure && proposal && error && <button type="button" disabled={fontBusy || composingRef.current || latest.current.isExporting}
      onClick={() => { const snapshot = contentRef.current;
        change({ ...snapshot, runs: applyRunStyle(snapshot.runs, 0, plainText(snapshot).length, { font: proposal }) }); }}>
      원본 대신 대체 글꼴 사용 동의
    </button>}
  </article>;
}

export function PdfRegionScreen(p: Props) {
  const latest = useRef(p); latest.current = p;
  const [source, setSource] = useState<Record<string, SourceTextPage>>({});
  const [renders, setRenders] = useState<Record<string, { key: string; render?: RenderedPage; error?: string }>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [twoPage, setTwoPage] = useState(false);
  const [dpr, setDpr] = useState(window.devicePixelRatio || 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const surfaces = useRef(new Map<string, HTMLElement>());
  const focusPending = useRef<string | null>(null);
  const pending = useRef(new Set<Promise<boolean>>());
  const commitQueue = useRef<Promise<void>>(Promise.resolve());
  const allowDrain = useRef(false);
  const compositions = useRef(new Set<string>());
  const invalid = useRef(new Set<string>());
  const index = p.workspace.pages.findIndex(item => item.id === p.workspace.activePageId);
  const start = twoPage && index > 0 ? index - (index - 1) % 2 : index;
  const visible = useMemo(() => p.workspace.pages.slice(start, start + (twoPage && start > 0 ? 2 : 1)), [p.workspace.pages, start, twoPage]);
  const requested = useMemo(() => {
    const ids = new Set(p.regionConfig.mappings.filter(mapping => p.regionConfig.selectedIds.includes(mapping.id) && mapping.anchor.kind === 'pdf')
      .map(mapping => mapping.anchor.kind === 'pdf' ? mapping.anchor.pageId : ''));
    return [...visible, ...p.workspace.pages.filter(page => ids.has(page.id) && !visible.some(item => item.id === page.id))];
  }, [visible, p.workspace.pages, p.regionConfig.mappings, p.regionConfig.selectedIds]);
  const sourceRequested = useMemo(() => {
    const ids = new Set(p.regionConfig.mappings.flatMap(mapping => mapping.anchor.kind === 'pdf' ? [mapping.anchor.pageId] : []));
    return [...requested, ...p.workspace.pages.filter(page => ids.has(page.id) && !requested.some(item => item.id === page.id))];
  }, [requested, p.workspace.pages, p.regionConfig.mappings]);
  const owner = `${p.workspace.id}:${p.engine.sessionId}`;
  const sourceKey = (sourcePageIndex: number) => `${owner}:${sourcePageIndex}`;
  const renderKey = `${owner}:${p.revision}:${p.zoom}:${dpr}`;
  const registerPending = useCallback((promise: Promise<boolean>) => {
    pending.current.add(promise);
    latest.current.onUnappliedEditChange(true);
    void promise.finally(() => {
      pending.current.delete(promise);
      latest.current.onUnappliedEditChange(pending.current.size > 0 || compositions.current.size > 0 || invalid.current.size > 0);
    });
  }, []);
  const runExclusive = useCallback((action: () => Promise<boolean>) => {
    const result = commitQueue.current.then(action);
    commitQueue.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);
  useEffect(() => {
    p.registerEditController({
      flush: async () => {
        if (compositions.current.size) { latest.current.showToast('한글 입력을 마친 뒤 저장하거나 이동해 주세요.'); return false; }
        allowDrain.current = true;
        try {
          for (;;) {
            const current = commitQueue.current;
            await current;
            const results = await Promise.all([...pending.current]);
            if (!results.every(Boolean) || invalid.current.size || compositions.current.size) return false;
            if (current === commitQueue.current && pending.current.size === 0) return true;
          }
        } finally { allowDrain.current = false; }
      },
      cancel: () => { setSelected([]); },
    });
    return () => { p.registerEditController(null); p.onUnappliedEditChange(false); };
  }, [p.registerEditController, p.onUnappliedEditChange]);
  useEffect(() => {
    const resize = () => setDpr(window.devicePixelRatio || 1);
    window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    let active = true;
    for (const page of sourceRequested) {
      if (page.kind !== 'pdf' || source[sourceKey(page.sourcePageIndex)]) continue;
      const key = sourceKey(page.sourcePageIndex);
      void p.engine.text(page.sourcePageIndex).then(result => { if (active) setSource(previous => ({ ...previous, [key]: result })); })
        .catch(error => { if (active) p.showToast(error instanceof Error ? error.message : '원본 텍스트를 읽을 수 없습니다.'); });
    }
    return () => { active = false; };
  }, [sourceRequested, owner, source, p.engine.text, p.showToast]);
  useEffect(() => {
    let active = true;
    for (const page of requested) {
      const key = `${renderKey}:${page.id}`;
      void p.engine.render(page, 96 / 72 * p.zoom * dpr, p.revision, 0, 'active')
        .then(render => { if (active) setRenders(previous => ({ ...previous, [page.id]: { key, render } })); })
        .catch(error => { if (active) setRenders(previous => ({ ...previous, [page.id]: { key, error: error instanceof Error ? error.message : '페이지 표시 실패' } })); });
    }
    return () => { active = false; };
  }, [requested, renderKey, p.engine.render, p.zoom, p.revision, dpr]);
  useEffect(() => { setSelected([]); setReviewConfirmed(false); }, [owner, p.regionConfig.reviewed]);
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        if (latest.current.regionConfig.reviewed && !pending.current.size && !compositions.current.size)
          latest.current.onRegionChange({ ...latest.current.regionConfig, selectedIds: [] });
        else if (!latest.current.regionConfig.reviewed) setSelected([]);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !(event.target instanceof HTMLTextAreaElement)) event.preventDefault();
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, []);
  const pages = p.workspace.pages.filter((page): page is PdfPage => page.kind === 'pdf');
  const mappedSourceInvalid = p.regionConfig.mappings.some(mapping => {
    const anchor = mapping.anchor;
    if (anchor.kind !== 'pdf') return true;
    const page = pages.find(item => item.id === anchor.pageId && item.sourcePageIndex === anchor.sourcePageIndex);
    const text = page && source[sourceKey(page.sourcePageIndex)];
    if (!page || !text || anchor.lineIds.some(id => !text.lines.some(line => line.lineId === id))
      || sourceOriginalText(text, anchor.lineIds) !== anchor.originalText) return true;
    const edit = page.textEdits.find(item => item.lineIds.some(id => anchor.lineIds.includes(id)));
    if (edit && (edit.lineIds.length !== anchor.lineIds.length
      || edit.lineIds.some(id => !anchor.lineIds.includes(id)))) return true;
    try {
      const content = edit?.content ?? (anchor.lineIds.length > 1
        ? buildSourceTextGroup(page, text, anchor.lineIds).content : text.lines.find(line => line.lineId === anchor.lineIds[0])!.content);
      return plainText(content) !== mapping.currentText;
    } catch { return true; }
  });
  const unresolvedMappings = p.regionConfig.reviewed && mappedSourceInvalid;
  const pick = (page: PdfPage, targets: readonly EditableTextTarget[]) => {
    if (p.isExporting || pending.current.size || !p.engine.info?.canEdit || (p.regionConfig.reviewed && unresolvedMappings)) return;
    const current = source[sourceKey(page.sourcePageIndex)];
    const rendered = renders[page.id];
    if (!current || !rendered?.render || rendered.key !== `${renderKey}:${page.id}`) return;
    const incoming: string[] = [];
    for (const item of targets) {
      const line = current.lines.find(value => value.lineId === item.lineIds[0]);
      if (!line) continue;
      const target = resolveTarget(page, line, rendered.render, current, item.lineIds);
      if (p.regionConfig.reviewed) {
        const mapping = p.regionConfig.mappings.find(value => mappedTarget(value, page, target, current));
        const reason = eligibility(page, line, target, current, p.regionConfig, rendered.render);
        if (!mapping || reason) { p.showToast(reason ?? '확인하지 않은 원본 영역입니다.'); continue; }
        incoming.push(mapping.id);
      } else incoming.push(keyOf(page.id, target.lineIds));
    }
    if (!incoming.length) return;
    if (p.regionConfig.reviewed) p.onRegionChange({ ...p.regionConfig, selectedIds: [...new Set([...p.regionConfig.selectedIds, ...incoming])] });
    else setSelected(previous => [...new Set([...previous, ...incoming])]);
  };
  const assign = (role: RegionRole | 'locked') => {
    const mappings = p.regionConfig.mappings.filter(mapping => !selected.some(key => {
      if (mapping.anchor.kind !== 'pdf') return false;
      const [pageId, lineIds] = JSON.parse(key) as [string, string[]];
      return mapping.anchor.pageId === pageId && mapping.anchor.lineIds.some(id => lineIds.includes(id));
    }));
    const additions: RegionMapping[] = [];
    for (const key of selected) {
      const [pageId, lineIds] = JSON.parse(key) as [string, string[]];
      const page = pages.find(item => item.id === pageId);
      const text = page && source[sourceKey(page.sourcePageIndex)];
      const original = text?.lines.find(item => item.lineId === lineIds[0]);
      const rendered = page && renders[page.id];
      if (!page || !text || !original || !rendered?.render || rendered.key !== `${renderKey}:${page.id}`) {
        p.showToast('원본 영역을 다시 불러온 뒤 역할을 지정해 주세요.'); return;
      }
      const target = resolveTarget(page, original, rendered.render, text, lineIds);
      if (role !== 'locked' && (!p.engine.info?.canEdit || !target.editable)) {
        p.showToast(target.reason || original.reason || '원본 영역을 안전하게 편집할 수 없습니다.'); return;
      }
      additions.push({ id: crypto.randomUUID(), role, anchor: { kind: 'pdf', pageId, sourcePageIndex: page.sourcePageIndex,
        lineIds: [...target.lineIds], originalText: sourceOriginalText(text, target.lineIds) }, currentText: plainText(target.content) });
    }
    if (role !== 'locked') {
      const config = { ...p.regionConfig, mappings: [...mappings, ...additions] };
      for (const mapping of additions) {
        const anchor = mapping.anchor;
        if (anchor.kind !== 'pdf') continue;
        const page = pages.find(item => item.id === anchor.pageId)!;
        const text = source[sourceKey(page.sourcePageIndex)];
        const original = text.lines.find(item => item.lineId === anchor.lineIds[0])!;
        const target = resolveTarget(page, original, renders[page.id].render!, text, anchor.lineIds);
        const reason = eligibility(page, original, target, text, config, renders[page.id].render);
        if (reason) { p.showToast(reason); return; }
      }
    }
    p.onRegionChange({ ...p.regionConfig, mappings: [...mappings, ...additions], selectedIds: [], reviewed: false });
    setReviewConfirmed(false);
    setSelected([]);
  };
  const groupSelected = () => {
    const parsed = selected.map(key => JSON.parse(key) as [string, string[]]);
    if (parsed.length < 2 || parsed.some(([pageId]) => pageId !== parsed[0][0])) {
      p.showToast('같은 원본 페이지의 연속된 줄만 한 항목으로 묶을 수 있습니다.'); return;
    }
    const page = pages.find(item => item.id === parsed[0][0]);
    const text = page && source[sourceKey(page.sourcePageIndex)];
    if (!page || !text) return;
    try {
      const group = buildSourceTextGroup(page, text, [...new Set(parsed.flatMap(([, ids]) => ids))]);
      setSelected([keyOf(page.id, group.lineIds)]);
    } catch (error) { p.showToast(error instanceof Error ? error.message : '원본 줄을 안전하게 묶을 수 없습니다.'); }
  };
  const cards = p.regionConfig.selectedIds.flatMap(id => {
    const mapping = p.regionConfig.mappings.find(item => item.id === id && item.role !== 'locked' && item.anchor.kind === 'pdf');
    if (!mapping) return [];
    const anchor = mapping.anchor;
    if (anchor.kind !== 'pdf') return [];
    const page = pages.find(item => item.id === anchor.pageId && item.sourcePageIndex === anchor.sourcePageIndex);
    if (!page) return [];
    const key = keyOf(page.id, anchor.lineIds);
    const text = source[sourceKey(page.sourcePageIndex)];
    const line = text?.lines.find(item => item.lineId === anchor.lineIds[0]);
    const rendering = renders[page.id];
    if (!text || !line || !rendering?.render || !rendering.key.startsWith(`${owner}:`))
      return [<article key={mapping.id} role="status">{REGION_ROLE_LABELS[mapping.role as RegionRole]} · {page.label} · 원본을 읽는 중…</article>];
    const renderedTarget = resolveTarget(page, line, rendering.render, text, anchor.lineIds);
    const edit = page.textEdits.find(item => item.lineIds.length === anchor.lineIds.length
      && item.lineIds.every((member, index) => member === anchor.lineIds[index]));
    const target = edit ? { ...renderedTarget, content: edit.content, widthPt: edit.widthPt,
      ...(edit.layout ? { layout: edit.layout } : {}) } : renderedTarget;
    const freshRender = rendering.key === `${renderKey}:${page.id}`;
    const reason = unresolvedMappings ? '잠긴 영역이나 원본 값을 확인할 수 없어 모든 영역 편집을 중단했습니다.'
      : freshRender ? eligibility(page, line, target, text, p.regionConfig, rendering.render) : null;
    return [<RegionCard key={mapping.id} page={page} line={line} target={target} mapping={mapping} reason={reason} sourceFonts={text.fonts}
      latest={latest} registerPending={registerPending} runExclusive={runExclusive} allowDrain={allowDrain}
      onCompositionActive={active => { if (active) compositions.current.add(id); else compositions.current.delete(id);
        p.onUnappliedEditChange(pending.current.size > 0 || compositions.current.size > 0 || invalid.current.size > 0); }}
      onInvalid={failed => { if (failed) invalid.current.add(id); else invalid.current.delete(id);
        p.onUnappliedEditChange(pending.current.size > 0 || compositions.current.size > 0 || invalid.current.size > 0); }}
      onRelease={() => {
        if (pending.current.size || compositions.current.size || invalid.current.size) { p.showToast('작성 중인 영역 값을 먼저 확인해 주세요.'); return; }
        p.onRegionChange({ ...p.regionConfig, selectedIds: p.regionConfig.selectedIds.filter(value => value !== id) });
      }} onHighlight={() => {
        if (pending.current.size || compositions.current.size || invalid.current.size) { p.showToast('작성 중인 영역 값을 먼저 확인해 주세요.'); return; }
        focusPending.current = key;
        p.goToPageIndex(p.workspace.pages.findIndex(item => item.id === page.id));
        const element = surfaces.current.get(key);
        if (element) { element.scrollIntoView({ behavior: 'smooth', block: 'center' }); focusPending.current = null; }
      }} />];
  });
  return <div data-screen-label="보호 영역 PDF 편집기" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    <DocumentHeader fileName={p.workspace.fileName} busy={p.isExporting} format="pdf" onFileNameChange={p.onFileNameChange} onHome={p.goToUpload} onExport={p.goExport}
      saveLabel={p.hasUnappliedEdit ? '원본에 적용되지 않은 입력' : p.saveStatus === 'saved' ? '자동 저장됨' : p.saveStatus === 'saving' ? '저장 중…' : '저장되지 않은 변경'}
      saveError={p.saveError} onRetrySave={p.onRetrySave} />
    <div className="pdfe-region-toolbar" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: 12, borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
      <strong>{p.regionConfig.reviewed ? '보호된 텍스트 편집' : '원본 줄 역할 지정'}</strong>
      {!p.regionConfig.reviewed ? <><span>선택한 {selected.length}개 원본 항목에 역할을 직접 지정하세요. 지정하지 않은 내용은 잠깁니다.</span>
        <span role="note">PDF는 원본에서 실제로 추출·교체할 수 있는 텍스트만 지정합니다. 빈칸·스캔 글자는 OCR이나 가상 필드로 대신 만들지 않습니다.</span>
        <label>선택한 줄의 역할 <select aria-label="선택한 줄의 역할" disabled={!selected.length || p.isExporting} defaultValue="" onChange={event => { if (event.target.value) assign(event.target.value as RegionRole | 'locked'); event.target.value = ''; }}>
          <option value="">역할 선택</option>{Object.entries(REGION_ROLE_LABELS).map(([role, label]) => <option key={role} value={role}>{label}</option>)}<option value="locked">보호 잠금</option>
        </select></label>
        <button disabled={selected.length < 2 || p.isExporting} onClick={groupSelected}>선택한 연속 줄을 한 항목으로 묶기</button>
        <label><input type="checkbox" checked={reviewConfirmed} onChange={event => setReviewConfirmed(event.target.checked)} /> 출결과 교사 확인 영역 및 역할을 원본에서 검토했습니다.</label>
        <button disabled={!reviewConfirmed || mappedSourceInvalid || !p.regionConfig.mappings.some(mapping => mapping.role !== 'locked')
          || p.isExporting || pending.current.size > 0 || !p.engine.info?.canEdit}
          onClick={() => { setSelected([]); p.onRegionChange({ ...p.regionConfig, reviewed: true }); }}>역할 검토 완료</button>
      </> : <><span>{p.regionConfig.selectedIds.length}개 원본 항목 선택됨</span>
        <button disabled={!p.regionConfig.selectedIds.length || pending.current.size > 0 || compositions.current.size > 0 || invalid.current.size > 0}
          onClick={() => p.onRegionChange({ ...p.regionConfig, selectedIds: [] })}>모두 선택 해제</button>
        <button disabled={p.isExporting || pending.current.size > 0 || compositions.current.size > 0 || invalid.current.size > 0}
          onClick={() => p.onRegionChange({ ...p.regionConfig, reviewed: false })}>역할 다시 지정</button></>}
      <button aria-pressed={twoPage} onClick={() => setTwoPage(value => !value)}>두 페이지 보기</button>
      <label>페이지 <select aria-label="페이지 선택" value={p.workspace.activePageId}
        onChange={event => p.goToPageIndex(p.workspace.pages.findIndex(page => page.id === event.target.value))}>
        {p.workspace.pages.map((page, i) => <option key={page.id} value={page.id}>{i + 1} 페이지</option>)}</select></label>
      <button disabled={index <= 0} onClick={() => p.goToPageIndex(index - 1)}>이전 페이지</button>
      <button disabled={index >= p.workspace.pages.length - 1} onClick={() => p.goToPageIndex(index + 1)}>다음 페이지</button>
      <button onClick={() => p.setZoom(Math.max(.25, p.zoom - .1))}>축소</button><span>{Math.round(p.zoom * 100)}%</span><button onClick={() => p.setZoom(Math.min(4, p.zoom + .1))}>확대</button>
    </div>
    <div className="pdfe-region-layout" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div ref={scrollRef} className="pdfe-scroll pdfe-region-source" style={{ flex: 1, minWidth: 0, overflow: 'auto', background: CANVAS_BG, padding: '30px', display: 'flex', alignItems: 'flex-start', gap: 24 }}>
        {visible.map((page, offset) => {
          const rendering = renders[page.id], fresh = rendering?.key === `${renderKey}:${page.id}`;
          const text = page.kind === 'pdf' ? source[sourceKey(page.sourcePageIndex)] : undefined;
          const targets = page.kind === 'pdf' && text && rendering?.render && fresh
            ? [...new Map(text.lines.map(line => {
              const mapped = p.regionConfig.mappings.find(mapping => mapping.anchor.kind === 'pdf' && mapping.anchor.pageId === page.id
                && mapping.anchor.lineIds.includes(line.lineId));
              const lineIds = mapped?.anchor.kind === 'pdf' ? mapped.anchor.lineIds
                : page.textEdits.find(edit => edit.lineIds.includes(line.lineId))?.lineIds ?? [line.lineId];
              const target = resolveTarget(page, line, rendering.render!, text, lineIds);
              return [keyOf(page.id, target.lineIds), target] as const;
            })).values()] : undefined;
          return <section key={page.id} aria-label={`${start + offset + 1} 페이지`} style={{ flex: '0 0 auto' }}>
            <div style={{ textAlign: 'center' }}>{start + offset + 1} 페이지</div>
            {fresh && rendering.render ? <div style={{ position: 'relative' }}>
              <PdfPageSurface page={page} render={rendering.render} zoom={p.zoom} tool="select" disabled={p.isExporting || pending.current.size > 0 || unresolvedMappings || !text || !p.engine.info?.canEdit || page.kind !== 'pdf'} scrollRef={scrollRef}
                selectedIds={p.regionConfig.reviewed
                  ? p.regionConfig.mappings.flatMap(mapping => p.regionConfig.selectedIds.includes(mapping.id) && mapping.anchor.kind === 'pdf' && mapping.anchor.pageId === page.id ? mapping.anchor.lineIds : [])
                  : selected.flatMap(key => { const [pageId, ids] = JSON.parse(key) as [string, string[]]; return pageId === page.id ? ids : []; })}
                multiSelect regionMode targets={targets} onTargetElement={(target, element) => {
                  const key = keyOf(page.id, target.lineIds);
                  if (element) { surfaces.current.set(key, element); if (focusPending.current === key) { element.scrollIntoView({ behavior: 'smooth', block: 'center' }); focusPending.current = null; } }
                  else surfaces.current.delete(key);
                }} onSelect={target => { if (page.kind === 'pdf') pick(page, [target]); }}
                onSelectMany={hits => { if (page.kind === 'pdf') pick(page, hits); }} onClearSelection={() => {}} />
            </div> : rendering?.error && fresh ? <div role="alert">{rendering.error} <button onClick={() => void p.engine.retry().catch(error => p.showToast(String(error)))}>다시 시도</button></div> : <div role="status">페이지를 여는 중…</div>}
          </section>;
        })}
      </div>
      {p.regionConfig.reviewed && <aside aria-label="보호 영역 편집 카드" className="pdfe-scroll pdfe-region-cards"
        style={{ width: 340, flexShrink: 0, overflowY: 'auto', display: 'grid', alignContent: 'start', gap: 12, padding: 12,
          borderLeft: `1px solid ${BORDER}`, background: SURFACE }}>
        {unresolvedMappings && <p role="alert">원본 영역이나 잠긴 범위를 확인할 수 없어 전체 영역 편집을 잠갔습니다. 역할을 다시 확인해 주세요.</p>}
        {cards.length ? cards : <p>왼쪽 원본을 클릭하거나 사각형으로 드래그해 지정된 항목을 추가하세요.</p>}
      </aside>}
    </div>
  </div>;
}

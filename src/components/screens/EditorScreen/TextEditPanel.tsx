import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ChangeEvent, CompositionEvent, KeyboardEvent } from 'react';
import type { EditableTextTarget, EditValidation, SourceFontInfo } from '../../../pdf/engineTypes';
import type { DownloadedFontAsset, EditController, FontChoice, Page, RGB, TextContent, TextStyle } from '../../../types/pdfEditor';
import { applyRunStyle, defaultTextStyle, normalizeInput, normalizeRuns, plainText, reconcileInput, spliceRuns, styleAt } from '../../../pdf/textEditing';
import type { InputAnchor, TextSelection } from '../../../pdf/textEditing';

// Bridge cache keys outlive a panel mount, so candidates must never reuse an ID.
let candidateSequence = 0;

export interface TextEditPanelProps {
  page: Page;
  target: EditableTextTarget;
  sourceFonts?: SourceFontInfo[];
  fontAssets?: DownloadedFontAsset[];
  downloadFont: (font: Extract<FontChoice, { kind: 'source' }>) => Promise<DownloadedFontAsset>;
  baseRevision: number;
  validate: (page: Page, revision: number, candidateRevision?: number) => Promise<EditValidation>;
  getRevision: () => number;
  onCommit: (content: TextContent, widthPt: number, fontAssets: DownloadedFontAsset[]) => void;
  onCancel: () => void;
  onPreview: (page: Page | null, candidateRevision: number) => void;
  onDirtyChange: (dirty: boolean) => void;
  registerController: (controller: EditController | null) => void;
  showToast: (message: string) => void;
  disabled?: boolean;
  requiresCommit?: boolean;
}
interface Draft { content: TextContent; width: string; size: string; selection: TextSelection }
interface CapturedInput { draft: Draft; anchor: InputAnchor }
const rgbToHex = (rgb: RGB) => '#' + rgb.map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
const hexToRgb = (hex: string): RGB => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
const fontValue = (font: FontChoice) => font.kind === 'bundled' ? font.family : font.kind === 'source' ? JSON.stringify([font.sourcePageIndex, font.fontKey]) : JSON.stringify([font.assetId]);

export function TextEditPanel(props: TextEditPanelProps) {
  const current = useRef(props);
  current.current = props;
  const original = useRef({ content: props.target.content, width: props.target.widthPt });
  const [draft, setDraft] = useState<Draft>(() => ({ content: props.target.content, width: String(props.target.widthPt), size: String(props.target.content.runs[0]?.style.sizePt ?? 12), selection: { start: 0, end: 0 } }));
  const initialDraft = useRef(draft);
  const live = useRef(draft);
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  const [waitingForComposition, setWaitingForComposition] = useState(false);
  const waitingForCompositionRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<FontChoice | null>(null);
  const proposalWholeTarget = useRef(false);
  const [busy, setBusy] = useState(false);
  const [pendingAssets, setPendingAssets] = useState<DownloadedFontAsset[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const downloadingRef = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const input = useRef<CapturedInput | null>(null);
  const composing = useRef(false);
  const composition = useRef<CapturedInput | null>(null);
  const completedComposition = useRef<string | null>(null);
  const compositionWaiters = useRef<Array<() => void>>([]);
  const history = useRef<{ undo: Draft[]; redo: Draft[] }>({ undo: [], redo: [] });
  const generation = useRef(0);
  if (generation.current === 0) generation.current = ++candidateSequence;
  const attempt = useRef(0);
  const active = useRef(true);
  const pendingSelection = useRef<TextSelection | null>(null);
  const initialRevision = useRef(props.baseRevision);
  const targetKey = `source:${JSON.stringify(props.target.lineIds)}`;
  const identity = useRef(`${props.page.id}:${targetKey}`);
  const dirty = !!props.requiresCommit || JSON.stringify(draft.content) !== JSON.stringify(original.current.content) || Number(draft.width) !== original.current.width || draft.size !== String(styleAt(draft.content.runs, draft.selection.start).sizePt);

  function change(next: Draft, record = true, compositionInput = false) {
    if (!active.current || lockedRef.current || ((current.current.disabled || waitingForCompositionRef.current) && !compositionInput)) return;
    if (record) {
      history.current.undo = [...history.current.undo, live.current].slice(-20);
      history.current.redo = [];
    }
    generation.current = ++candidateSequence;
    live.current = next;
    setDraft(next);
    setError(null);
    setProposal(null);
  }
  function cancel() {
    if (!active.current) return;
    active.current = false;
    generation.current = ++candidateSequence;
    attempt.current++;
    compositionWaiters.current.splice(0).forEach(resolve => resolve());
    current.current.onPreview(null, generation.current);
    current.current.onDirtyChange(false);
    current.current.onCancel();
  }
  function candidate(snapshot: Draft): Page {
    const { page, target } = current.current;
    const widthPt = Number(snapshot.width);
    if (page.kind !== 'pdf') throw new Error('원본 텍스트 페이지가 올바르지 않습니다.');
    const members = new Set(target.lineIds);
    return { ...page, textEdits: [...page.textEdits.filter(edit => !edit.lineIds.some(id => members.has(id))), { lineIds: target.lineIds, layout: target.layout, content: snapshot.content, widthPt }] };
  }
  function validInput(snapshot: Draft): boolean {
    const width = Number(snapshot.width), size = Number(snapshot.size);
    if (!Number.isFinite(width) || width <= 0) { setError('텍스트 폭은 0보다 큰 point 값이어야 합니다.'); return false; }
    if (!Number.isFinite(size) || size < 6 || size > 96) { setError('글자 크기는 6–96pt로 입력해 주세요.'); return false; }
    return true;
  }
  async function apply(flush: boolean): Promise<boolean> {
    if (!active.current || (!flush && current.current.disabled) || !current.current.target.editable) return false;
    if (downloadingRef.current) return false;
    if (waitingForCompositionRef.current) return false;
    if (composing.current) {
      waitingForCompositionRef.current = true;
      setWaitingForComposition(true);
      try {
        await new Promise<void>(resolve => compositionWaiters.current.push(resolve));
      } finally {
        waitingForCompositionRef.current = false;
        setWaitingForComposition(false);
      }
    }
    if (!active.current || composing.current) return false;
    if (lockedRef.current) return false;
    if (flush) { lockedRef.current = true; setLocked(true); }
    const token = ++attempt.current;
    try {
      const snapshot = live.current;
      const revision = current.current.baseRevision;
      const capturedGeneration = generation.current;
      const capturedIdentity = identity.current;
      if (current.current.getRevision() !== revision) return false;
      if (!current.current.requiresCommit && JSON.stringify(snapshot.content) === JSON.stringify(initialDraft.current.content)
        && snapshot.width === initialDraft.current.width && snapshot.size === initialDraft.current.size) { cancel(); return true; }
      if (!validInput(snapshot)) return false;
      if (!current.current.requiresCommit && JSON.stringify(snapshot.content) === JSON.stringify(original.current.content) && Number(snapshot.width) === original.current.width) { cancel(); return true; }
      setBusy(true);
      const payload = candidate(snapshot);
      const result = await current.current.validate(payload, revision, capturedGeneration);
      const latest = current.current;
      const latestKey = `${latest.page.id}:source:${JSON.stringify(latest.target.lineIds)}`;
      if (!active.current || token !== attempt.current || capturedGeneration !== generation.current || capturedIdentity !== latestKey || revision !== latest.baseRevision || revision !== latest.getRevision()) return false;
      if (!result.ok) { setError(result.message); proposalWholeTarget.current = true; setProposal(result.proposedFont ?? null); return false; }
      // Only this immutable, validated snapshot is ever committed.
      const referencedAssets = pendingAssets.filter(asset => snapshot.content.runs.some(run => run.style.font.kind === 'downloaded' && run.style.font.assetId === asset.id));
      current.current.onCommit(snapshot.content, Number(snapshot.width), referencedAssets);
      cancel();
      return true;
    } catch (caught) {
      if (active.current && token === attempt.current) setError(caught instanceof Error ? caught.message : '텍스트를 적용하지 못했습니다.');
      return false;
    } finally {
      if (token === attempt.current || !active.current) setBusy(false);
      if (flush) { lockedRef.current = false; setLocked(false); }
    }
  }
  const operations = useRef({ apply, cancel });
  operations.current = { apply, cancel };
  useEffect(() => {
    active.current = true;
    props.registerController({ flush: () => operations.current.apply(true), cancel: () => operations.current.cancel() });
    return () => {
      active.current = false;
      generation.current = ++candidateSequence;
      attempt.current++;
      compositionWaiters.current.splice(0).forEach(resolve => resolve());
      current.current.registerController(null);
      current.current.onPreview(null, generation.current);
      current.current.onDirtyChange(false);
    };
  }, []);
  useEffect(() => {
    if (props.baseRevision !== initialRevision.current || `${props.page.id}:${targetKey}` !== identity.current) operations.current.cancel();
  }, [props.baseRevision, props.page.id, targetKey]);
  useEffect(() => { props.onDirtyChange(dirty); }, [dirty, props.onDirtyChange]);
  useEffect(() => {
    if (!active.current || composing.current) return;
    if (!dirty) { current.current.onPreview(null, generation.current); return; }
    const version = generation.current;
    const timer = window.setTimeout(() => {
      if (!active.current || version !== generation.current || composing.current) return;
      if (validInput(live.current)) current.current.onPreview(candidate(live.current), version);
      else current.current.onPreview(null, version);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [draft, dirty]);
  useLayoutEffect(() => {
    if (pendingSelection.current && textarea.current) {
      textarea.current.setSelectionRange(pendingSelection.current.start, pendingSelection.current.end);
      pendingSelection.current = null;
    }
  }, [draft]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const capture = (event: InputEvent) => {
      const compositionInput = composing.current && (event.isComposing || event.inputType === 'insertCompositionText' || event.inputType === 'insertFromComposition' || event.inputType === 'deleteCompositionText');
      if (!active.current || lockedRef.current || ((current.current.disabled || waitingForCompositionRef.current) && !compositionInput)) {
        event.preventDefault();
        return;
      }
      if (composing.current) return;
      if (event.inputType !== 'insertCompositionText' && event.inputType !== 'insertFromComposition') completedComposition.current = null;
      input.current = { draft: live.current, anchor: { start: element.selectionStart, end: element.selectionEnd, inputType: event.inputType || 'insertText' } };
    };
    element.addEventListener('beforeinput', capture);
    return () => element.removeEventListener('beforeinput', capture);
  }, []);
  function updateText(event: ChangeEvent<HTMLTextAreaElement>) {
    const element = event.currentTarget;
    const native = event.nativeEvent as InputEvent;
    const compositionInput = composing.current && (native.isComposing || native.inputType === 'insertCompositionText' || native.inputType === 'insertFromComposition' || native.inputType === 'deleteCompositionText');
    if (!active.current || lockedRef.current || ((current.current.disabled || waitingForCompositionRef.current) && !compositionInput)) return;
    if (!composing.current && completedComposition.current !== null && normalizeInput(element.value).text === completedComposition.current) {
      completedComposition.current = null;
      input.current = null;
      return;
    }
    const captured = composition.current ?? input.current ?? { draft: live.current, anchor: { ...live.current.selection, inputType: 'insertText' } };
    let runs = reconcileInput(captured.draft.content.runs, captured.anchor, element.value);
    let selection = { start: element.selectionStart, end: element.selectionEnd };
    if (!composing.current) {
      const normalized = normalizeInput(element.value, selection.start, selection.end);
      runs = normalizeRuns(runs);
      selection = { start: normalized.start, end: normalized.end };
      pendingSelection.current = selection;
    }
    change({ ...live.current, content: { ...live.current.content, runs }, selection, size: String(styleAt(runs, selection.start).sizePt) }, !composing.current, compositionInput);
    input.current = null;
  }
  function endComposition(event: CompositionEvent<HTMLTextAreaElement>) {
    const captured = composition.current;
    if (!captured || !active.current || lockedRef.current) return;
    const normalized = normalizeInput(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
    const runs = normalizeRuns(reconcileInput(captured.draft.content.runs, captured.anchor, event.currentTarget.value));
    history.current.undo = [...history.current.undo, captured.draft].slice(-20);
    history.current.redo = [];
    composing.current = false;
    composition.current = null;
    completedComposition.current = normalized.text;
    pendingSelection.current = { start: normalized.start, end: normalized.end };
    change({ ...live.current, content: { ...live.current.content, runs }, selection: pendingSelection.current, size: String(styleAt(runs, normalized.start).sizePt) }, false, true);
    compositionWaiters.current.splice(0).forEach(resolve => resolve());
  }
  function format(patch: Partial<TextStyle>) {
    if (composing.current) return;
    const snapshot = live.current;
    change({ ...snapshot, content: { ...snapshot.content, runs: applyRunStyle(snapshot.content.runs, snapshot.selection.start, snapshot.selection.end, patch) }, size: patch.sizePt === undefined ? snapshot.size : String(patch.sizePt) });
  }
  function localUndo(redo: boolean) {
    if (!active.current || lockedRef.current || composing.current || waitingForCompositionRef.current || current.current.disabled) return;
    const from = redo ? history.current.redo : history.current.undo;
    const previous = from.pop();
    if (!previous) return;
    const to = redo ? history.current.undo : history.current.redo;
    to.push(live.current);
    if (to.length > 20) to.shift();
    pendingSelection.current = previous.selection;
    change(previous, false);
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing.current || event.nativeEvent.isComposing) { event.stopPropagation(); return; }
    if (event.key === 'Escape') { event.preventDefault(); return; }
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void apply(false); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); localUndo(event.shiftKey); }
  }
  async function download(source: Extract<FontChoice, { kind: 'source' }>) {
    if (!active.current || downloadingRef.current || lockedRef.current || composing.current || current.current.disabled) return;
    const revision = current.current.baseRevision;
    downloadingRef.current = true;
    setDownloading(fontValue(source));
    setError(null);
    try {
      const asset = await current.current.downloadFont(source);
      if (!active.current || current.current.getRevision() !== revision || current.current.baseRevision !== revision) return;
      const snapshot = live.current;
      const runs = snapshot.content.runs.map(run => run.style.font.kind === 'source' && run.style.font.sourcePageIndex === source.sourcePageIndex && run.style.font.fontKey === source.fontKey
        ? { ...run, style: { ...run.style, font: { kind: 'downloaded' as const, assetId: asset.id } } } : run);
      setPendingAssets(previous => [...previous.filter(item => item.id !== asset.id), asset]);
      change({ ...snapshot, content: { ...snapshot.content, runs: normalizeRuns(runs) } });
    } catch (caught) {
      if (active.current) setError(caught instanceof Error ? caught.message : '글꼴 다운로드에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      downloadingRef.current = false;
      if (active.current) setDownloading(null);
    }
  }
  const sourceChoices = [...new Map([...original.current.content.runs, ...draft.content.runs]
    .filter(run => run.style.font.kind === 'source')
    .map(run => [fontValue(run.style.font), run.style.font as Extract<FontChoice, { kind: 'source' }>])).values()];
  const assets = [...(props.fontAssets ?? []), ...pendingAssets];
  const downloadedChoices = [...new Set([...original.current.content.runs, ...draft.content.runs].flatMap(run => run.style.font.kind === 'downloaded' ? [run.style.font.assetId] : []).concat(pendingAssets.map(asset => asset.id)))];
  const sourceDetails = new Map(props.sourceFonts?.map(info => [fontValue({ kind: 'source', sourcePageIndex: info.sourcePageIndex, fontKey: info.fontKey }), info]));
  const style = styleAt(draft.content.runs, draft.selection.start, defaultTextStyle());
  const font = style.font;
  const unavailable = locked || waitingForComposition || !!downloading || props.disabled || !props.target.editable;
  // An already-open IME session must deliver its final input before flush locks it.
  const textareaUnavailable = locked || !!downloading || !props.target.editable || ((waitingForComposition || props.disabled) && !composing.current);
  const grouped = props.target.lineIds.length > 1;
  return <section className="text-edit-panel pdfe-panel-enter" aria-label={grouped ? '묶은 텍스트 편집' : '텍스트 편집'} onKeyDown={event => {
    if (event.key === 'Escape') { if (composing.current) event.stopPropagation(); else event.preventDefault(); }
  }}>
    <div className="text-edit-panel-heading"><strong>{grouped ? '묶은 텍스트 편집' : '텍스트 편집'}</strong><button className="pdfe-icon-button" type="button" onClick={cancel} aria-label="텍스트 편집 닫기"><X size={24} strokeWidth={1.5} /></button></div>
    <div className="text-edit-panel-body pdfe-scroll">
    {grouped && <p role="note">선택한 {props.target.lineIds.length}개 원본 줄을 하나로 묶어 편집합니다. Enter로 명시적인 줄바꿈을 넣을 수 있습니다.</p>}
    {!props.target.editable && <p role="alert">{props.target.reason}</p>}
    {sourceChoices.length > 0 && <div aria-label="원본 글꼴 정보">
      {sourceChoices.map(source => {
        const info = sourceDetails.get(fontValue(source));
        const matching = draft.content.runs.some(run => run.style.font.kind === 'source' && fontValue(run.style.font) === fontValue(source));
        return <div key={fontValue(source)} style={{ marginBottom: 10 }}>
          <strong>{info?.declaredName || '이름을 확인할 수 없는 원본 글꼴'}</strong>
          {info?.family && <div>{info.family} · 굵기 {info.weight} · {info.italic ? 'Italic' : '직립체'}</div>}
          <div>{info?.embedded === true ? 'PDF에 포함된 글꼴입니다. 일부 문자만 포함되어 있을 수 있습니다.' : info?.embedded === false ? 'PDF에 원본 글꼴이 포함되어 있지 않습니다.' : '원본 글꼴의 PDF 포함 여부를 확인할 수 없습니다.'}</div>
          {info?.catalogId ? <><div>같은 이름·스타일의 공개 라이선스 글꼴을 사용할 수 있습니다. 필요한 글꼴·라이선스만 GitHub에서 가져오며 PDF는 전송하지 않습니다.</div>
            <button type="button" disabled={unavailable || composing.current || !matching} onClick={() => void download(source)}>
              {downloading === fontValue(source) ? '다운로드 중…' : matching ? '다운로드해서 적용' : '초안에서 다른 글꼴 사용 중'}
            </button></> : <div>{info?.unavailableReason || '일치하는 다운로드 글꼴을 찾을 수 없습니다.'}</div>}
        </div>;
      })}
      <p role="note">다운로드한 글꼴은 이 편집 초안의 같은 원본 글꼴에만 적용합니다. 아래 ‘적용’으로 확정하며 ‘취소’하면 문서는 바뀌지 않습니다. 원본과 제작 버전·글자 폭이 다를 수 있습니다.</p>
    </div>}
    {downloadedChoices.length > 0 && <p role="status">다운로드 글꼴: {downloadedChoices.map(id => assets.find(asset => asset.id === id)?.postScriptName || '저장된 글꼴').join(', ')}</p>}
    <textarea ref={textarea} aria-label="텍스트 내용" value={plainText(draft.content)} disabled={textareaUnavailable}
      onChange={updateText} onKeyDown={keyDown}
      onSelect={event => {
        if (composing.current || lockedRef.current || waitingForCompositionRef.current || current.current.disabled) return;
        const selection = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
        const next = { ...live.current, selection, size: String(styleAt(live.current.content.runs, selection.start).sizePt) };
        live.current = next; setDraft(next);
      }}
      onCompositionStart={event => {
        if (!active.current || lockedRef.current || waitingForCompositionRef.current || current.current.disabled) return;
        composing.current = true;
        generation.current = ++candidateSequence;
        composition.current = { draft: live.current, anchor: { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd, inputType: 'insertCompositionText' } };
      }} onCompositionEnd={endComposition}
      onPaste={event => {
        event.preventDefault();
        if (composing.current || unavailable) return;
        const selection = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
        const inserted = normalizeInput(event.clipboardData.getData('text/plain')).text;
        const runs = normalizeRuns(spliceRuns(live.current.content.runs, selection.start, selection.end, inserted));
        const offset = normalizeInput(plainText(live.current.content).slice(0, selection.start) + inserted).text.length;
        pendingSelection.current = { start: offset, end: offset };
        change({ ...live.current, content: { ...live.current.content, runs }, selection: pendingSelection.current });
      }} />
    <fieldset disabled={unavailable || composing.current}>
      <legend>PDF 텍스트 서식</legend>
      <label>글꼴 <select aria-label="글꼴" value={fontValue(font)} onChange={event => {
        const value = event.target.value;
        const source = sourceChoices.find(choice => fontValue(choice) === value);
        const downloaded = assets.find(asset => fontValue({ kind: 'downloaded', assetId: asset.id }) === value);
        if (source) format({ font: source });
        else if (downloaded) format({ font: { kind: 'downloaded', assetId: downloaded.id } });
        else if (value === 'NanumGothic' || value === 'NanumMyeongjo' || value === 'Courier') format({ font: { kind: 'bundled', family: value, bold: font.kind === 'bundled' && font.bold } });
      }}>
        {sourceChoices.map(source => <option key={fontValue(source)} value={fontValue(source)}>원본: {sourceDetails.get(fontValue(source))?.declaredName || '이름을 확인할 수 없는 원본 글꼴'}</option>)}
        {downloadedChoices.map(id => <option key={id} value={fontValue({ kind: 'downloaded', assetId: id })}>{assets.find(asset => asset.id === id)?.postScriptName || '다운로드 글꼴'}</option>)}
        <option value="NanumGothic">나눔고딕</option><option value="NanumMyeongjo">나눔명조</option><option value="Courier">Courier</option>
      </select></label>
      <label>크기 (pt) <input aria-label="글자 크기 (pt)" inputMode="decimal" value={draft.size} onChange={event => {
        const value = event.target.value, size = Number(value);
        if (value.trim() && Number.isFinite(size) && size >= 6 && size <= 96) {
          const snapshot = live.current;
          change({ ...snapshot, size: value, content: { ...snapshot.content, runs: applyRunStyle(snapshot.content.runs, snapshot.selection.start, snapshot.selection.end, { sizePt: size }) } });
        } else change({ ...live.current, size: value });
      }} /></label>
      <button type="button" aria-pressed={font.kind === 'bundled' && font.bold} onClick={() => {
        if (font.kind !== 'bundled') { proposalWholeTarget.current = false; setProposal({ kind: 'bundled', family: 'NanumGothic', bold: true }); setError('선택한 글꼴의 다른 굵기 face를 확인할 수 없습니다. 나눔고딕 Bold로 바꾸시겠습니까?'); }
        else format({ font: { ...font, bold: !font.bold } });
      }}>굵게</button>
      <label>글자색 <input aria-label="글자색" type="color" value={rgbToHex(style.color)} onChange={event => format({ color: hexToRgb(event.target.value) })} /></label>
      <label>정렬 <select aria-label="정렬" value={draft.content.align} onChange={event => {
        const align = event.target.value;
        if (align === 'left' || align === 'center' || align === 'right') change({ ...live.current, content: { ...live.current.content, align } });
      }}><option value="left">왼쪽</option><option value="center">가운데</option><option value="right">오른쪽</option></select></label>
      <label>폭 (pt) <input aria-label="텍스트 폭 (pt)" inputMode="decimal" value={draft.width} onChange={event => change({ ...live.current, width: event.target.value })} /></label>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {proposal && <button type="button" disabled={unavailable} onClick={() => {
      if (proposalWholeTarget.current) {
        const snapshot = live.current;
        change({ ...snapshot, content: { ...snapshot.content, runs: applyRunStyle(snapshot.content.runs, 0, plainText(snapshot.content).length, { font: proposal }) } });
      } else format({ font: proposal });
    }}>대체 글꼴 사용 동의</button>}
    </div>
    <div className="text-edit-panel-actions"><button type="button" disabled={unavailable || composing.current} onClick={() => void apply(false)}>{busy ? '검증 중…' : '적용'}</button><button type="button" onClick={cancel}>취소</button></div>
  </section>;
}
export default TextEditPanel;

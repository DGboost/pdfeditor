import { SuperDoc } from 'superdoc';
import { unzipSync, strFromU8 } from 'fflate';
import { isEnforcedProtection } from './protection';
import { shouldWarnExternalRelationship } from './relationships';
import { serveOfficeFrame } from '../../src/documents/frameBridge';
import type { FormatValue, OfficeFrameOpen, OfficeSession, OfficeState } from '../../src/documents/officeTypes';
import type { SelectionBookmark, Transaction } from '../../vendor/superdoc/packages/super-editor/src/editors/v1/core/Editor';
import { BUNDLED_MANIFEST } from '../../vendor/superdoc/shared/font-system/src/bundled-manifest';
import { ACCENT, BORDER, CANVAS_BG, FONT_STACK, SURFACE, SURFACE_SOFT, TEXT, TEXT_MUTED } from '../../src/styles/theme';
import 'superdoc/style.css';
import './style.css';

type Editor = NonNullable<SuperDoc['activeEditor']>;
for (const [name, value] of Object.entries({
  '--sd-ui-font-family': FONT_STACK,
  '--sd-ui-text': TEXT,
  '--sd-ui-text-muted': TEXT_MUTED,
  '--sd-ui-border-color': BORDER,
  '--sd-ui-bg': SURFACE,
  '--sd-ui-action': ACCENT,
  '--sd-ui-action-hover': TEXT,
  '--sd-ui-comments-card-bg': SURFACE_SOFT,
  '--sd-ui-comments-card-active-bg': SURFACE,
  '--sd-ui-comments-input-bg': SURFACE,
  '--sd-ui-comments-input-border': BORDER,
  '--docx-canvas': CANVAS_BG,
})) document.documentElement.style.setProperty(name, value);
const surface = document.querySelector<HTMLElement>('#superdoc')!;
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const unavailable = <T>(reason = '현재 선택에서 확인 불가'): FormatValue<T> => ({ kind: 'unavailable', reason });
const uniform = <T>(value: T): FormatValue<T> => ({ kind: 'uniform', value });
const families = ['NanumGothic', 'NanumMyeongjo'].map((family) => ({
  family,
  faces: [400, 700].map((weight) => ({
    source: new URL(`../fonts/${family.toLowerCase()}/${family}-${weight === 400 ? 'Regular' : 'Bold'}.ttf`, document.baseURI).href,
    weight,
  })),
}));

function inspectPackage(bytes: Uint8Array) {
  const parts = unzipSync(bytes, { filter: ({ name }) => name === 'word/settings.xml' || name.endsWith('.rels') });
  const xml = (value: Uint8Array) => {
    const document = new DOMParser().parseFromString(strFromU8(value), 'application/xml');
    if (document.querySelector('parsererror')) throw new Error('DOCX 설정 XML이 손상되었습니다.');
    return document;
  };
  let protectedDocument = false;
  const settings = parts['word/settings.xml'];
  if (settings) {
    for (const element of xml(settings).getElementsByTagName('*')) {
      if (isEnforcedProtection(element.localName, element.attributes)) protectedDocument = true;
    }
  }
  const external = Object.entries(parts).some(([name, value]) => name.endsWith('.rels') && [...xml(value).getElementsByTagName('*')].some((el) => el.localName === 'Relationship' && shouldWarnExternalRelationship(el.getAttribute('TargetMode'), el.getAttribute('Type'))));
  return { protectedDocument, external };
}

async function open(request: OfficeFrameOpen, sessionId: string): Promise<OfficeSession> {
  if (request.format !== 'docx') throw new Error('DOCX 형식이 아닙니다.');
  if (request.checkpoint && (request.checkpoint.kind !== 'native' || request.checkpoint.format !== 'docx')) throw new Error('DOCX 복구 형식이 일치하지 않습니다.');
  const protection = inspectPackage(new Uint8Array(await request.source.arrayBuffer()));
  const documentBlob = request.checkpoint?.kind === 'native' ? request.checkpoint.bytes : request.source;
  const warnings = new Set<string>();
  if (protection.protectedDocument) warnings.add('보호된 문서입니다. 보기와 보존 원본 다운로드만 가능합니다.');
  if (protection.external) warnings.add('외부 이미지·미디어 관계는 자동으로 불러오지 않습니다. 원본은 보존됩니다.');
  let disposed = false, ready = false;
  let revision = request.initialRevision, selectionRevision = 0;
  let startupFailure: unknown;
  let runtime: SuperDoc;
  const listeners = new Set<(state: OfficeState) => void>();
  const subscriptions = new Map<Editor, () => void>();
  const surfaces = new Map<NonNullable<Editor['presentationEditor']>, () => void>();
  const roots = new Set<Editor>();
  const mutations = new WeakSet<object>();
  let bookmark: { editor: Editor; value: SelectionBookmark } | undefined;
  let state: OfficeState;
  // A preview describes the last completed native paint, not an atomic document/export revision.
  let renderRevision = 0, viewportFrame = 0;
  const previewMounts = new Set<HTMLElement>();
  const resourceController = new AbortController();
  const resources = new Map<string, Promise<string>>();
  const presentation = () => runtime?.activeEditor?.getHostEditors()[0]?.presentationEditor;
  const abortPreview = () => new DOMException('페이지 미리보기가 변경되었습니다.', 'AbortError');
  function invalidatePreview() { renderRevision++; onViewport(); publish(); }
  let currentPage = 0;
  function measurePage() {
    const pageCount = presentation()?.getPages().length ?? 0;
    currentPage = Math.min(currentPage, Math.max(0, pageCount - 1));
    let best = -1;
    for (const page of surface.querySelectorAll<HTMLElement>('.superdoc-page[data-page-index]')) {
      const rect = page.getBoundingClientRect();
      const visible = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      if (visible > best && visible > 0) { best = visible; currentPage = Number(page.dataset.pageIndex); }
    }
  }
  function pageState() {
    const pageCount = presentation()?.getPages().length ?? 0;
    currentPage = Math.min(currentPage, Math.max(0, pageCount - 1));
    return { pageCount, currentPage, twoPage: false, renderRevision };
  }
  const onViewport = () => {
    if (!viewportFrame) viewportFrame = requestAnimationFrame(() => { viewportFrame = 0; measurePage(); publish(); });
  };
  const onResource = (event: Event) => {
    if (event.target instanceof HTMLImageElement && surface.contains(event.target)) invalidatePreview();
  };
  async function embedResource(source: string): Promise<string> {
    const url = new URL(source, document.baseURI);
    if (url.protocol === 'data:') return url.href;
    if (!['http:', 'https:', 'blob:'].includes(url.protocol) || url.origin !== location.origin) return '';
    let resource = resources.get(url.href);
    if (!resource) {
      resource = (async () => {
        const response = await fetch(url.href, { signal: resourceController.signal, redirect: 'error' });
        if (!response.ok) throw new Error('페이지 리소스를 읽을 수 없습니다.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return `data:${response.headers.get('content-type') ?? 'application/octet-stream'};base64,${btoa(binary)}`;
      })();
      resources.set(url.href, resource);
      void resource.catch(() => { if (resources.get(url.href) === resource) resources.delete(url.href); });
    }
    return resource;
  }
  async function embedCss(value: string): Promise<string> {
    const matches = [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)];
    for (const match of matches) {
      const url = new URL(match[2], document.baseURI);
      const localFragment = url.hash && url.href.slice(0, -url.hash.length) === location.href.split('#')[0];
      value = value.replace(match[0], `url("${localFragment ? url.hash : await embedResource(match[2])}")`);
    }
    return value;
  }
  async function thumbnail(pageNumber: number, expectedRevision: number): Promise<Blob> {
    const native = presentation();
    const check = () => {
      if (disposed || expectedRevision !== renderRevision || native !== presentation()) throw abortPreview();
    };
    check();
    if (!native || !Number.isInteger(pageNumber) || pageNumber < 0 || pageNumber >= native.getPages().length) throw new RangeError('페이지 범위를 벗어났습니다.');
    const mount = document.createElement('div');
    mount.inert = true;
    mount.setAttribute('aria-hidden', 'true');
    mount.style.cssText = 'position:fixed;left:-100000px;top:0;contain:strict;width:10000px;height:10000px;pointer-events:none;overflow:hidden';
    const page = native.renderPagePreview(pageNumber);
    mount.append(page);
    previewMounts.add(mount);
    document.body.append(mount);
    try {
      const width = page.offsetWidth, height = page.offsetHeight;
      if (!(width > 0 && height > 0)) throw new Error('페이지 크기를 확인할 수 없습니다.');
      const elements = [page, ...page.querySelectorAll<HTMLElement | SVGElement>('*')];
      // Freeze the native DOM's computed appearance before removing it from its stylesheet context.
      const usedFonts = new Map<string, { family: string; weight: string; style: string }>();
      const styles = elements.map((element) => {
        const computed = getComputedStyle(element);
        const hasText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim());
        return [...computed].map((property) => {
          const value = computed.getPropertyValue(property);
          if (property === 'font-family' && hasText) {
            // Embedded FontFace byte buffers are not exportable through CSSOM; unsupported
            // faces retain their browser fallback stack only in the detached preview.
            for (const item of value.split(',')) {
              const family = item.trim().replace(/^['"]|['"]$/g, '');
              const weight = Number(computed.fontWeight) >= 600 ? '700' : '400';
              const style = computed.fontStyle === 'italic' ? 'italic' : 'normal';
              usedFonts.set(`${family}|${weight}|${style}`, { family, weight, style });
            }
          }
          return [property, value] as const;
        });
      });
      const fontRules = new Set<CSSFontFaceRule>();
      const cssFonts = new Set<string>();
      const collectFonts = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSFontFaceRule) {
            const family = rule.style.fontFamily.replace(/^['"]|['"]$/g, '');
            const weights = (rule.style.fontWeight || '400').replace('normal', '400').replace('bold', '700').split(/\s+/).map(Number);
            const style = rule.style.fontStyle || 'normal';
            for (const [key, font] of usedFonts) {
              if (font.family === family && font.style === style && Number(font.weight) >= weights[0] && Number(font.weight) <= (weights[1] ?? weights[0])) {
                fontRules.add(rule); cssFonts.add(key);
              }
            }
          }
          else if ('cssRules' in rule) collectFonts((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        try { collectFonts(sheet.cssRules); } catch { /* Cross-origin stylesheets are not fetched. */ }
      }
      const nativeFonts = await Promise.all([...usedFonts.values()].map(async ({ family, weight, style }) => {
        if (cssFonts.has(`${family}|${weight}|${style}`)) return '';
        const bundled = BUNDLED_MANIFEST.find((entry) => entry.family === family)?.faces.find((face) => (face.weight === 'bold' ? '700' : '400') === weight && face.style === style);
        const local = families.find((entry) => entry.family === family)?.faces.find((face) => String(face.weight) === weight);
        const source = bundled ? new URL(`./fonts/${bundled.file}`, document.baseURI).href : local?.source;
        return source ? `@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};src:url("${await embedResource(source)}")}` : '';
      }));
      const fonts = [...nativeFonts, ...await Promise.all([...fontRules].map(async (rule) => `@font-face{${await embedCss(rule.style.cssText)}}`))].join('\n');
      // Share identical computed declarations instead of repeating hundreds of defaults per node.
      const shared = new Map(styles[0]);
      for (const declarations of styles.slice(1)) {
        const values = new Map(declarations);
        for (const [property, value] of shared) if (values.get(property) !== value) shared.delete(property);
      }
      const sharedCss = (await Promise.all([...shared].map(async ([property, value]) => `${property}:${value.includes('url(') ? await embedCss(value) : value}`))).join(';');
      check();
      const styleClasses = new Map<string, string>();
      await Promise.all(elements.map(async (element, index) => {
        const declarations = await Promise.all(styles[index].filter(([property]) => !shared.has(property)).map(async ([property, value]) => {
          return `${property}:${value.includes('url(') ? await embedCss(value) : value}`;
        }));
        const css = declarations.join(';');
        let className = styleClasses.get(css);
        if (!className) { className = `docx-preview-style-${styleClasses.size}`; styleClasses.set(css, className); }
        element.removeAttribute('style');
        element.classList.add('docx-preview-node', className);
        for (const attribute of [...element.attributes]) if (attribute.name.startsWith('on') || ['contenteditable', 'srcset'].includes(attribute.name)) element.removeAttribute(attribute.name);
        if (element instanceof HTMLImageElement) {
          const source = await embedResource(element.currentSrc || element.src);
          if (source) element.src = source; else element.removeAttribute('src');
        }
        if (element instanceof SVGElement && element.localName === 'image') {
          const source = element.getAttribute('href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
          if (source) {
            const embedded = await embedResource(source);
            element.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
            if (embedded) element.setAttribute('href', embedded); else element.removeAttribute('href');
          }
        }
      }));
      check();
      page.style.position = 'relative'; page.style.top = '0'; page.style.left = '0'; page.style.margin = '0'; page.style.transform = 'none';
      for (const unwanted of page.querySelectorAll('script,iframe,object,embed,link')) unwanted.remove();
      const style = document.createElement('style');
      style.textContent = `${fonts}\n.docx-preview-node{${sharedCss}}\n${[...styleClasses].map(([css, name]) => `.${name}{${css}}`).join('\n')}`;
      page.prepend(style);
      page.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      const scaledWidth = 192, scaledHeight = Math.max(1, Math.round(scaledWidth * height / width));
      return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${scaledWidth}" height="${scaledHeight}" viewBox="0 0 ${width} ${height}"><foreignObject width="${width}" height="${height}">${new XMLSerializer().serializeToString(page)}</foreignObject></svg>`], { type: 'image/svg+xml' });
    } finally { mount.remove(); previewMounts.delete(mount); }
  }
  const editors = () => [...new Set([...roots].filter((editor) => !editor.isDestroyed).flatMap((editor) => editor.getHostEditors()))];
  const composing = () => editors().some((editor) => editor.view?.composing);
  function activeEditor(): Editor | null {
    const editor = runtime?.activeEditor;
    return editor?.presentationEditor?.getActiveEditor() ?? editor ?? null;
  }
  const markValue = (editor: Editor): OfficeState['formatting'] => {
    const data = editor.getHostFormattingState();
    const mixed = data.mixedRunProperties ?? {};
    const properties = data.resolvedRunProperties ?? {};
    const boolean = (name: 'bold' | 'italic' | 'underline'): FormatValue<boolean> => {
      if (mixed[name]) return { kind: 'mixed' };
      let value = properties[name];
      if (value == null) return uniform(false);
      if (typeof value === 'object') {
        const attributes = value as Record<string, unknown>;
        value = attributes.underlineType ?? attributes.value ?? attributes.val ?? attributes['w:val'] ?? true;
      }
      return uniform(![false, 0, '0', 'false', 'off', 'none'].includes(value as string | number | boolean));
    };
    const field = <T>(name: string, convert: (value: unknown) => T | undefined): FormatValue<T> => {
      if (mixed[name]) return { kind: 'mixed' };
      const value = convert(properties[name]);
      return value === undefined ? unavailable() : uniform(value);
    };
    return {
      bold: boolean('bold'), italic: boolean('italic'), underline: boolean('underline'),
      fontFamily: data.hostFontFamily.kind === 'unavailable' ? unavailable() : data.hostFontFamily,
      fontSize: field('fontSize', (value) => {
        // Native resolved OOXML run sizes are half-points, not CSS pixels.
        if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value / 2 : undefined;
        const match = typeof value === 'string' ? value.match(/^([\d.]+)(pt|px)$/) : null;
        if (!match) return undefined;
        const result = Number(match[1]) * (match[2] === 'px' ? 72 / 96 : 1);
        return Number.isFinite(result) && result > 0 ? result : undefined;
      }),
      color: field('color', (value) => {
        if (value && typeof value === 'object') {
          const attributes = value as Record<string, unknown>;
          value = attributes.val ?? attributes['w:val'];
        }
        return typeof value === 'string' && /^#?[\da-f]{6}$/i.test(value) ? `#${value.replace('#', '')}` : undefined;
      }),
    };
  };
  let selectionCache: { editor: Editor | null; nativeState: Editor['state'] | undefined; revision: number; editable: boolean; enabled: OfficeState['enabled']; formatting: OfficeState['formatting'] } | undefined;
  function publish() {
    if (disposed || !runtime) return;
    discover();
    const editor = activeEditor();
    const isComposing = composing();
    const editable = ready && !isComposing && !protection.protectedDocument && !!editor?.isEditable && !editor.isDestroyed;
    if (!selectionCache || selectionCache.editor !== editor || selectionCache.nativeState !== editor?.state || selectionCache.revision !== revision || selectionCache.editable !== editable) {
      const canUndo = editable && !!editor?.can().undo();
      const canRedo = editable && !!editor?.can().redo();
      selectionCache = {
        editor, nativeState: editor?.state, revision, editable,
        enabled: {
          undo: canUndo, redo: canRedo,
          bold: editable && !!editor?.can().toggleBold(),
          italic: editable && !!editor?.can().toggleItalic(),
          underline: editable && !!editor?.can().toggleUnderline(),
          fontFamily: editable && !!editor?.can().setFontFamily('NanumGothic'),
          fontSize: editable && !!editor?.can().setFontSize('12pt'),
          color: editable && !!editor?.can().setColor('#000000'),
          zoom: ready && !isComposing,
        },
        formatting: editor && !editor.isDestroyed ? markValue(editor) : { bold: unavailable(), italic: unavailable(), underline: unavailable(), fontFamily: unavailable(), fontSize: unavailable(), color: unavailable() },
      };
    }
    const { enabled, formatting } = selectionCache;
    state = {
      sessionId, revision, selectionRevision, ready, busy: false, composing: isComposing, canUndo: enabled.undo, canRedo: enabled.redo,
      canSaveModified: !protection.protectedDocument,
      zoom: runtime.getZoom() / 100,
      pageView: pageState(),
      enabled: { ...enabled, zoom: ready && !isComposing }, formatting,
      fonts: families.map(({ family }) => ({ value: family, label: family })), warnings: [...warnings],
    };
    for (const listener of listeners) listener(state);
  }
  function remember(editor: Editor) {
    if (activeEditor() !== editor || editor.isDestroyed) return;
    bookmark = { editor, value: editor.state.selection.getBookmark() };
  }
  function discover() {
    if (runtime?.activeEditor) {
      const root = runtime.activeEditor.getHostEditors()[0];
      if (!roots.has(root)) { roots.add(root); root.on('host-mutation', mutation); }
      const presentation = root.presentationEditor;
      if (presentation && !surfaces.has(presentation)) {
        const changed = () => {
          bookmark = undefined;
          selectionRevision++;
          const editor = activeEditor();
          if (editor) remember(editor);
          publish();
        };
        presentation.on('activeSurfaceChange', changed);
        const layout = () => { invalidatePreview(); };
        presentation.on('layoutUpdated', layout);
        surfaces.set(presentation, () => { presentation.off('activeSurfaceChange', changed); presentation.off('layoutUpdated', layout); });
      }
    }
    for (const editor of editors()) {
      if (subscriptions.has(editor)) continue;
      const selection = () => { selectionRevision++; remember(editor); publish(); };
      const transaction = ({ transaction, appliedTransactions }: { transaction: Transaction; appliedTransactions?: readonly Transaction[] }) => {
        if (bookmark?.editor === editor) for (const applied of appliedTransactions ?? [transaction]) bookmark.value = bookmark.value.map(applied.mapping);
        if ((appliedTransactions ?? [transaction]).some((applied) => applied.docChanged || applied.storedMarksSet)) selectionRevision++;
        publish();
      };
      editor.on('selectionUpdate', selection);
      editor.on('focus', selection);
      if (!roots.has(editor)) editor.on('host-mutation', mutation);
      editor.on('transaction', transaction);
      subscriptions.set(editor, () => { editor.off('selectionUpdate', selection); editor.off('focus', selection); editor.off('transaction', transaction); editor.off('host-mutation', mutation); });
    }
    for (const [editor, unsubscribe] of subscriptions) if (editor.isDestroyed) { unsubscribe(); subscriptions.delete(editor); if (bookmark?.editor === editor) bookmark = undefined; }
  }
  const mutation = (payload: object) => {
    if (mutations.has(payload)) return;
    mutations.add(payload);
    if (ready) revision++;
    publish();
  };
  const onCreate = ({ editor }: { editor: Editor }) => {
    const root = editor.getHostEditors()[0];
    if (!roots.has(root)) { roots.add(root); root.on('host-mutation', mutation); }
    if (runtime) publish();
  };
  const security = () => { warnings.add('문서의 외부 리소스가 차단되었습니다. 일부 이미지·글꼴이 표시되지 않을 수 있습니다.'); publish(); };
  const onComposition = () => { publish(); requestAnimationFrame(() => publish()); };
  const onKey = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && ['s', 'p'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopImmediatePropagation(); bridge.requestSave(); }
  };
  const onDrop = (event: DragEvent) => {
    const file = event.dataTransfer?.files[0];
    if (file && /\.(pdf|docx|hwp|hwpx|pptx|doc|ppt)$/i.test(file.name)) { event.preventDefault(); event.stopImmediatePropagation(); bridge.requestOpen(file); }
  };
  const inputWaiters = new Map<number, (reason: DOMException) => void>();
  async function flush() {
    while (!disposed) {
      discover();
      if (!composing()) {
        const settled = editors().every((editor) => editor.flushPendingInputForHost().ok)
          && [...roots].every((root) => root.isDestroyed || root.flushPendingInputForExport().ok);
        if (settled && !disposed) {
          publish();
          return true;
        }
      }
      if (disposed) break;
      // Poll real composition state; disposal cancels the frame and rejects now,
      // even when the browser has suspended animation frames for this document.
      await new Promise<void>((resolve, reject) => {
        const frame = requestAnimationFrame(() => {
          inputWaiters.delete(frame);
          resolve();
        });
        inputWaiters.set(frame, reject);
      });
    }
    throw new DOMException('DOCX 세션이 닫혔습니다.', 'AbortError');
  }
  let capture: Promise<{ revision: number; bytes: Blob; warnings: string[] }> | undefined;
  const serialize = () => {
    if (capture) return capture;
    capture = (async () => {
      if (protection.protectedDocument) throw new Error('보호된 문서는 수정본으로 저장할 수 없습니다.');
      await flush();
      if (disposed) throw new DOMException('DOCX 세션이 닫혔습니다.', 'AbortError');
      for (;;) {
        const capturedRevision = revision;
        const bytes = await runtime.export({ exportType: ['docx'], triggerDownload: false, isFinalDoc: false });
        if (disposed) throw new DOMException('DOCX 세션이 닫혔습니다.', 'AbortError');
        if (!(bytes instanceof Blob) || bytes.size === 0) throw new Error('DOCX 직렬화 결과가 비어 있습니다.');
        // Export reads some document parts asynchronously. Flush input again and
        // discard a stale capture without interrupting typing or reporting a save error.
        await flush();
        if (revision === capturedRevision) return { revision: capturedRevision, bytes, warnings: [...warnings] };
      }
    })().finally(() => { capture = undefined; });
    return capture;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    document.body.inert = true;
    resourceController.abort();
    resources.clear();
    for (const mount of previewMounts) mount.remove();
    previewMounts.clear();
    cancelAnimationFrame(viewportFrame);
    document.removeEventListener('scroll', onViewport, true);
    window.removeEventListener('resize', onViewport);
    document.removeEventListener('load', onResource, true);
    document.fonts.removeEventListener('loadingdone', invalidatePreview);
    const error = new DOMException('DOCX 세션이 닫혔습니다.', 'AbortError');
    for (const [frame, reject] of inputWaiters) {
      cancelAnimationFrame(frame);
      reject(error);
    }
    inputWaiters.clear();
    for (const root of roots) root.off('host-mutation', mutation);
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    for (const unsubscribe of surfaces.values()) unsubscribe();
    surfaces.clear();
    subscriptions.clear(); roots.clear(); listeners.clear(); bookmark = undefined;
    document.removeEventListener('securitypolicyviolation', security);
    document.removeEventListener('compositionstart', onComposition, true);
    document.removeEventListener('compositionend', onComposition, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('drop', onDrop, true);
    runtime?.destroy(); surface.replaceChildren();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      runtime = new SuperDoc({
        selector: '#superdoc', document: new File([documentBlob], 'document.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
        documentMode: 'viewing', telemetry: { enabled: false }, modules: {},
        fonts: { families, assetBaseUrl: new URL('./fonts/', document.baseURI).href },
        zoom: { fitWidth: { min: 25, max: 400 } },
        onEditorCreate: onCreate,
        onReady: () => resolve(),
        onException: ({ error }: { error: unknown }) => { if (!ready) { startupFailure = error; reject(error); } else if (!capture) bridge.reportError(error instanceof Error ? error.message : 'DOCX 엔진 오류'); },
        onContentError: () => {
          const error = new Error('DOCX 내용을 불러오지 못했습니다.');
          if (!ready) { startupFailure = error; reject(error); } else bridge.reportError(error.message);
        },
      });
    });
    if (!protection.protectedDocument) runtime.setDocumentMode('editing');
    runtime.on('editorDestroy', publish);
    runtime.on('zoomChange', publish);
    discover();
    document.addEventListener('securitypolicyviolation', security);
    document.addEventListener('compositionstart', onComposition, true);
    document.addEventListener('compositionend', onComposition, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('scroll', onViewport, true);
    window.addEventListener('resize', onViewport);
    document.addEventListener('load', onResource, true);
    document.fonts.addEventListener('loadingdone', invalidatePreview);
    while (!surface.querySelector('.superdoc-page')?.getBoundingClientRect().height) {
      if (startupFailure) throw startupFailure;
      await nextPaint();
    }
    await nextPaint(); await nextPaint();
    ready = true; measurePage(); publish();
    return {
      pageView: {
        thumbnail,
        async execute(command) {
          if (disposed || !ready || composing()) return { ok: false, reason: '현재 페이지 보기를 변경할 수 없습니다.' };
          if (command.type === 'twoPage') return { ok: false, reason: 'DOCX 엔진은 두 페이지 보기를 지원하지 않습니다.' };
          if (command.type === 'fitWidth') { runtime.setZoomMode('fit-width'); publish(); return { ok: true }; }
          const native = presentation();
          if (!native || !Number.isInteger(command.page) || command.page < 0 || command.page >= native.getPages().length) return { ok: false, reason: '페이지 범위를 벗어났습니다.' };
          const ok = await native.scrollToPage(command.page + 1, 'auto');
          if (disposed) return { ok: false, reason: 'DOCX 세션이 닫혔습니다.' };
          measurePage(); publish();
          return ok ? { ok: true } : { ok: false, reason: '페이지로 이동할 수 없습니다.' };
        },
      },
      getState: () => state,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async execute(command) {
        if (disposed) return { ok: false, reason: 'DOCX 세션이 닫혔습니다.' };
        publish();
        if (!state.enabled[command.type]) return { ok: false, reason: '현재 문서 또는 선택에서 사용할 수 없습니다.' };
        if (command.type === 'zoom') { if (!Number.isFinite(command.value) || command.value < 0.25 || command.value > 4) return { ok: false, reason: '배율 범위는 25–400%입니다.' }; runtime.setZoom(command.value * 100); publish(); return { ok: true }; }
        const editor = activeEditor();
        if (!editor || editor.isDestroyed || !editor.isEditable || protection.protectedDocument) return { ok: false, reason: '편집 권한이 없습니다.' };
        if (bookmark && bookmark.editor !== editor) { bookmark = undefined; return { ok: false, reason: '선택한 문서 영역이 변경되었습니다.' }; }
        if (bookmark) editor.view.dispatch(editor.state.tr.setSelection(bookmark.value.resolve(editor.state.doc)));
        if (command.type === 'fontSize' && (!Number.isFinite(command.value) || command.value < 8 || command.value > 96)) return { ok: false, reason: '글자 크기는 8–96pt입니다.' };
        if (command.type === 'fontFamily' && !families.some(({ family }) => family === command.value)) return { ok: false, reason: '설치된 로컬 글꼴을 선택해 주세요.' };
        if (command.type === 'color' && !/^#[\da-f]{6}$/i.test(command.value)) return { ok: false, reason: '색상은 #RRGGBB 형식이어야 합니다.' };
        const commands = editor.commands;
        const ok = command.type === 'undo' ? commands.undo() : command.type === 'redo' ? commands.redo() : command.type === 'bold' ? commands.toggleBold() : command.type === 'italic' ? commands.toggleItalic() : command.type === 'underline' ? commands.toggleUnderline() : command.type === 'fontFamily' ? commands.setFontFamily(command.value) : command.type === 'fontSize' ? commands.setFontSize(`${command.value}pt`) : commands.setColor(command.value);
        editor.focus(); remember(editor); publish();
        return ok ? { ok: true } : { ok: false, reason: '이 선택에 명령을 적용할 수 없습니다.' };
      },
      flush, serialize,
      async captureCheckpoint() { const result = await serialize(); return { revision: result.revision, checkpoint: { kind: 'native', format: 'docx', bytes: result.bytes, warnings: result.warnings } }; },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}

const bridge = serveOfficeFrame(open);
window.addEventListener('pagehide', () => bridge.dispose());

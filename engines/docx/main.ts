import { SuperDoc } from 'superdoc';
import { unzipSync, strFromU8 } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { isEnforcedProtection } from './protection';
import { shouldWarnExternalRelationship } from './relationships';
import { serveOfficeFrame } from '../../src/documents/frameBridge';
import type { CountMetric, FormatValue, OfficeFrameOpen, OfficeSession, OfficeState, SourceAnalysis } from '../../src/documents/officeTypes';
import type { OfficeRegionTarget } from '../../src/documents/regionTypes';
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
function analysisCount(value: unknown, reason: string): CountMetric {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { kind: 'available', count: value }
    : { kind: 'unavailable', reason };
}

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
  const documentBlob = request.checkpoint?.kind === 'native' ? request.checkpoint.bytes : request.source;
  const sourceProtection = inspectPackage(new Uint8Array(await request.source.arrayBuffer()));
  const checkpointProtection = documentBlob === request.source ? sourceProtection :
    inspectPackage(new Uint8Array(await documentBlob.arrayBuffer()));
  const protection = {
    protectedDocument: sourceProtection.protectedDocument || checkpointProtection.protectedDocument,
    external: sourceProtection.external || checkpointProtection.external,
  };
  const warnings = new Set<string>();
  if (protection.protectedDocument) warnings.add('보호된 문서입니다. 보기와 보존 원본 다운로드만 가능합니다.');
  if (protection.external) warnings.add('외부 이미지·미디어 관계는 자동으로 불러오지 않습니다. 원본은 보존됩니다.');
  let disposed = false, ready = false;
  let sourceAnalysis: SourceAnalysis | undefined;
  let revision = request.initialRevision, selectionRevision = 0;
  let startupFailure: unknown;
  let runtime: SuperDoc;
  const listeners = new Set<(state: OfficeState) => void>();
  const subscriptions = new Map<Editor, () => void>();
  const surfaces = new Map<NonNullable<Editor['presentationEditor']>, () => void>();
  const roots = new Set<Editor>();
  const mutations = new WeakSet<object>();
  let bookmark: { editor: Editor; value: SelectionBookmark } | undefined;
  let regionMode: 'normal' | 'mapping' | 'protected' = 'normal';
  let nativeRegionReplace = false;
  let state: OfficeState;
  // A preview describes the last completed native paint, not an atomic document/export revision.
  let renderRevision = 0, viewportFrame = 0;
  let lastScrollX = 0, lastScrollY = 0, lastWidth = innerWidth, lastHeight = innerHeight;
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
    if (!viewportFrame) viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      const scroller = document.scrollingElement;
      const x = scroller?.scrollLeft ?? 0, y = scroller?.scrollTop ?? 0;
      if (x !== lastScrollX || y !== lastScrollY || innerWidth !== lastWidth || innerHeight !== lastHeight) {
        lastScrollX = x; lastScrollY = y; lastWidth = innerWidth; lastHeight = innerHeight;
        renderRevision++;
      }
      measurePage(); publish();
    });
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
  type NativeNode = Editor['state']['doc'];
  type ResolvedDocxRegion = { editor: Editor; paragraph: { node: NativeNode; start: number }; path: ParagraphPath; text: string; from: number; to: number; at: number; end: number };
  type ParagraphPath = { type: string; index: number }[];
  type DocxLocator = { v: 2; path: ParagraphPath; sourceId: string; container?: ParagraphPath; containerId?: string; before: string; after: string; at: number; tail: number; textLength: number; textHash: string };
  const targetFailure = (locator: string, reason: string): OfficeRegionTarget => ({ locator, text: '', boxes: [], reason });
  function paragraphAt(editor: Editor, path: ParagraphPath, doc = editor.state.doc) {
    let node: NativeNode = doc, start = 0;
    for (const { type, index } of path) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= node.childCount) return null;
      let offset = 0;
      for (let i = 0; i < index; i++) offset += node.child(i).nodeSize;
      start += (node.type.name === 'doc' ? 0 : 1) + offset;
      node = node.child(index);
      if (node.type.name !== type) return null;
    }
    return node.type.name === 'paragraph' ? { node, start } : null;
  }
  type TextSpan = { from: number; to: number; text: string; offset: number };
  function textSpans(paragraph: NativeNode, start: number) {
    const spans: TextSpan[] = [];
    const otherInline: { from: number; to: number }[] = [];
    let offset = 0;
    paragraph.descendants((node, pos) => {
      if (node.isText || node.type.name === 'lineBreak') {
        const text = node.isText ? node.text! : '\n';
        spans.push({ from: start + 1 + pos, to: start + 1 + pos + node.nodeSize, text, offset });
        offset += text.length;
      } else if (node.isInline && node.isLeaf) {
        otherInline.push({ from: start + 1 + pos, to: start + 1 + pos + node.nodeSize });
      }
    });
    return { spans, text: spans.map(({ text }) => text).join(''), otherInline };
  }
  function textBoundary(spans: TextSpan[], offset: number, paragraphStart: number, affinity: 'forward' | 'backward'): number {
    if (!spans.length) return paragraphStart + 1;
    const next = spans.find((span) => offset >= span.offset && offset < span.offset + span.text.length);
    if (next && (offset > next.offset || affinity === 'forward')) return next.from + offset - next.offset;
    const previous = spans.find((span) => span.offset + span.text.length === offset);
    return previous?.to ?? next?.from ?? paragraphStart + 1;
  }
  function parseLocator(locator: string): DocxLocator | null {
    try {
      const parsed: unknown = JSON.parse(locator);
      if (!parsed || typeof parsed !== 'object') return null;
      const value = parsed as Partial<DocxLocator>;
      if (value.v !== 2 || !Array.isArray(value.path) || value.path.length < 1 ||
        !value.path.every((part) => part && typeof part.type === 'string' && Number.isSafeInteger(part.index) && part.index >= 0) ||
        typeof value.sourceId !== 'string' ||
        (value.container !== undefined && (!Array.isArray(value.container) || !value.container.length ||
          !value.container.every((part) => part && typeof part.type === 'string' && Number.isSafeInteger(part.index) && part.index >= 0) ||
          value.container[value.container.length - 1].type !== 'structuredContent' ||
          typeof value.containerId !== 'string' || !value.containerId)) ||
        (value.container === undefined && value.containerId !== undefined) ||
        typeof value.before !== 'string' || typeof value.after !== 'string' ||
        !Number.isSafeInteger(value.at) || value.at! < 0 || !Number.isSafeInteger(value.tail) || value.tail! < 0 ||
        !Number.isSafeInteger(value.textLength) || value.textLength! < 0 || typeof value.textHash !== 'string' || !/^[\da-f]{64}$/.test(value.textHash)) return null;
      return value as DocxLocator;
    } catch { return null; }
  }
  function resolveRegion(locator: string, doc?: NativeNode): ResolvedDocxRegion | null {
    const source = parseLocator(locator);
    const editor = runtime?.activeEditor?.getHostEditors()[0];
    if (!source || !editor || editor.isDestroyed) return null;
    doc ??= editor.state.doc;
    const paragraph = paragraphAt(editor, source.path, doc);
    if (!paragraph) return null;
    const actualSourceId = typeof paragraph.node.attrs.paraId === 'string' ? paragraph.node.attrs.paraId : '';
    if (!source.sourceId || actualSourceId !== source.sourceId) return null;
    let matchingParagraphs = 0;
    doc.descendants((node) => {
      if (node.type.name === 'paragraph' && node.attrs.paraId === source.sourceId) matchingParagraphs++;
    });
    if (matchingParagraphs !== 1) return null;
    const { spans, text, otherInline } = textSpans(paragraph.node, paragraph.start);
    const fromOffset = source.at, toOffset = text.length - source.tail;
    if (fromOffset < source.before.length || toOffset < fromOffset || source.tail < source.after.length ||
      text.slice(fromOffset - source.before.length, fromOffset) !== source.before ||
      text.slice(toOffset, toOffset + source.after.length) !== source.after) return null;
    const value = text.slice(fromOffset, toOffset);
    if (value.length !== source.textLength || bytesToHex(sha256(utf8ToBytes(value))) !== source.textHash) return null;
    let from = textBoundary(spans, fromOffset, paragraph.start, fromOffset === toOffset ? 'backward' : 'forward');
    let to = fromOffset === toOffset ? from : textBoundary(spans, toOffset, paragraph.start, 'backward');
    if (source.container) {
      let node = paragraph.node, start = paragraph.start;
      for (const part of source.container) {
        if (part.index >= node.childCount) return null;
        let offset = 0;
        for (let index = 0; index < part.index; index++) offset += node.child(index).nodeSize;
        start += 1 + offset;
        node = node.child(part.index);
        if (node.type.name !== part.type) return null;
      }
      const id = typeof node.attrs.id === 'string' || typeof node.attrs.id === 'number' ? String(node.attrs.id) : '';
      if (!id || id !== source.containerId) return null;
      let matches = 0;
      doc.descendants((candidate) => {
        if (candidate.type.name === 'structuredContent' && String(candidate.attrs.id) === id) matches++;
      });
      if (matches !== 1) return null;
      if (fromOffset === toOffset) {
        const forward = textBoundary(spans, fromOffset, paragraph.start, 'forward');
        const inside = (position: number) => position > start && position < start + node.nodeSize;
        if (inside(from)) to = from;
        else if (inside(forward)) from = to = forward;
        else if (!node.textContent) from = to = start + 1;
        else return null;
      } else if (from <= start || to >= start + node.nodeSize) return null;
    }
    if ((!text && otherInline.length) || otherInline.some((inline) => inline.from < to && inline.to > from)) return null;
    // Direct PM transactions bypass SDT NodeView editability; enforce each
    // intrinsic content lock, including locks on enclosing nested controls.
    const structuredParents = (pos: number) => {
      const resolved = doc.resolve(pos);
      const parents: number[] = [];
      for (let depth = 1; depth <= resolved.depth; depth++) {
        const node = resolved.node(depth);
        if (node.type.name !== 'structuredContent' && node.type.name !== 'structuredContentBlock') continue;
        if (node.attrs.lockMode === 'contentLocked' || node.attrs.lockMode === 'sdtContentLocked') return null;
        parents.push(resolved.before(depth));
      }
      return parents;
    };
    const firstParents = structuredParents(from), lastParents = structuredParents(to);
    if (!firstParents || !lastParents || firstParents.join(',') !== lastParents.join(',')) return null;
    let crossesControl = false;
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name !== 'structuredContent' && node.type.name !== 'structuredContentBlock') return;
      if (node.attrs.lockMode === 'contentLocked' || node.attrs.lockMode === 'sdtContentLocked' ||
        from <= pos || to >= pos + node.nodeSize) {
        crossesControl = true;
        return false;
      }
    });
    if (crossesControl) return null;
    return { editor, paragraph, path: source.path, text: value, from, to, at: fromOffset, end: toOffset };
  }
  // Body paragraph block IDs are emitted unchanged by toFlowBlocks; table
  // paragraphs instead live inside generated table fragments. Never suffix-match
  // another story's block ID or resolve a table cell from a neighboring text hit.
  function paintedBoxes(resolved: ResolvedDocxRegion): OfficeRegionTarget['boxes'] {
    const tableDepth = resolved.path.findIndex((part) => part.type === 'table');
    const blockId = resolved.paragraph.node.attrs.sdBlockId ?? resolved.paragraph.node.attrs.paraId;
    let fragments: HTMLElement[] = [];
    if (tableDepth < 0) {
      if (typeof blockId !== 'string' || !blockId) return [];
      fragments = [...surface.querySelectorAll<HTMLElement>('.superdoc-fragment[data-block-id]')]
        .filter((fragment) => !fragment.classList.contains('superdoc-table-fragment') && fragment.dataset.blockId === blockId);
    } else {
      const tablePos = resolved.editor.state.doc.resolve(resolved.paragraph.start);
      const tableStart = tablePos.before(tableDepth + 1);
      let table = resolved.editor.state.doc;
      for (const part of resolved.path.slice(0, tableDepth + 1)) table = table.child(part.index);
      const rowIndex = resolved.path[tableDepth + 1]?.index;
      const cellIndex = resolved.path[tableDepth + 2]?.index;
      if (table.type.name !== 'table' || !Number.isSafeInteger(rowIndex) || rowIndex < 0 || rowIndex >= table.childCount ||
        !Number.isSafeInteger(cellIndex) || cellIndex < 0 || cellIndex >= table.child(rowIndex).childCount) return [];
      const first = resolved.paragraph.start + 1, last = resolved.paragraph.start + resolved.paragraph.node.nodeSize - 1;
      const sourceText = textSpans(resolved.paragraph.node, resolved.paragraph.start).text.replace(/\n/g, '');
      const matches: HTMLElement[][] = [];
      for (const fragment of surface.querySelectorAll<HTMLElement>('.superdoc-table-fragment[data-pm-start][data-pm-end]')) {
        const firstPm = Number(fragment.dataset.pmStart), lastPm = Number(fragment.dataset.pmEnd);
        if (!Number.isSafeInteger(firstPm) || !Number.isSafeInteger(lastPm) ||
          firstPm <= tableStart || lastPm >= tableStart + table.nodeSize ||
          firstPm > first || lastPm < last) continue;
        const rows = fragment.dataset.layoutFragmentId?.match(/table:(\d+):(\d+)$/);
        if (!rows) continue;
        const firstRow = Number(rows[1]), lastRow = Number(rows[2]);
        if (rowIndex < firstRow || rowIndex >= lastRow || lastRow > table.childCount) continue;
        let ordinal = cellIndex, count = 0;
        for (let index = firstRow; index < lastRow; index++) {
          if (index < rowIndex) ordinal += table.child(index).childCount;
          count += table.child(index).childCount;
        }
        const cell = fragment.children[ordinal];
        if (fragment.children.length !== count || !(cell instanceof HTMLElement)) continue;
        const lines = [...cell.querySelectorAll<HTMLElement>('.superdoc-line[data-pm-start][data-pm-end]')]
          .filter((line) => {
            const start = Number(line.dataset.pmStart), end = Number(line.dataset.pmEnd);
            return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= first && end <= last;
          });
        if (!lines.length || lines.flatMap((line) => [...line.querySelectorAll<HTMLElement>('.superdoc-text-run')])
          .map((run) => run.textContent).join('') !== sourceText) continue;
        // The renderer writes PM ranges on each line. Ordinal alone is not an
        // identity when adjacent cells have identical text or PM paint is stale.
        const sourceCell = table.child(rowIndex).child(cellIndex);
        matches.push(sourceCell.childCount === 1 && sourceCell.firstChild === resolved.paragraph.node ? [cell] : lines);
      }
      if (matches.length !== 1) return [];
      fragments = matches[0];
    }
    if (!fragments.length) return [];
    if (!resolved.text) {
      if (fragments.length !== 1) return [];
      const line = fragments[0].matches('.superdoc-line') ? fragments[0] : fragments[0].querySelector<HTMLElement>('.superdoc-line');
      const rect = line?.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0 ?
        [{ x: rect.left, y: rect.top, width: rect.width, height: rect.height }] : [];
    }
    const original = textSpans(resolved.paragraph.node, resolved.paragraph.start).text;
    const segments: { node: Text; from: number; to: number }[] = [];
    let offset = 0;
    for (const fragment of fragments) {
      for (const run of fragment.querySelectorAll<HTMLElement>('.superdoc-text-run')) {
        if (run.closest('.superdoc-structured-content-inline__label')) continue;
        const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const value = node.textContent ?? '';
          while (original[offset] === '\n') offset++;
          if (original.slice(offset, offset + value.length) !== value) return [];
          segments.push({ node: node as Text, from: offset, to: offset + value.length });
          offset += value.length;
        }
      }
    }
    if (original.slice(offset).replace(/\n/g, '') !== '') return [];
    const start = segments.find((segment) => resolved.at >= segment.from && resolved.at < segment.to);
    const end = segments.find((segment) => resolved.end > segment.from && resolved.end <= segment.to);
    if (!start || !end) return [];
    const range = document.createRange();
    try { range.setStart(start.node, resolved.at - start.from); range.setEnd(end.node, resolved.end - end.from); }
    catch { return []; }
    if (range.collapsed || range.toString().replace(/\n/g, '') !== resolved.text.replace(/\n/g, '')) return [];
    return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }));
  }
  function regionTarget(locator: string): OfficeRegionTarget {
    if (protection.protectedDocument) return targetFailure(locator, '원본 DOCX 문서가 편집을 금지합니다.');
    const resolved = resolveRegion(locator);
    if (!resolved) return targetFailure(locator, '원본 문단 또는 선택 범위를 정확히 다시 찾을 수 없거나 문서에서 잠겼습니다.');
    return { locator, text: resolved.text, boxes: paintedBoxes(resolved) };
  }
  function locatorForOffsets(editor: Editor, path: ParagraphPath, at: number, length: number, container?: ParagraphPath, doc = editor.state.doc): string | null {
    const paragraph = paragraphAt(editor, path, doc);
    if (!paragraph) return null;
    const { spans, text, otherInline } = textSpans(paragraph.node, paragraph.start);
    let containerId: string | undefined;
    if (container) {
      let node = paragraph.node;
      for (const part of container) {
        if (part.index >= node.childCount) return null;
        node = node.child(part.index);
        if (node.type.name !== part.type) return null;
      }
      if (typeof node.attrs.id !== 'string' && typeof node.attrs.id !== 'number') return null;
      containerId = String(node.attrs.id);
      if (!containerId) return null;
    }
    if (typeof paragraph.node.attrs.paraId !== 'string' || !paragraph.node.attrs.paraId) return null;
    if (at < 0 || length < 0 || at + length > text.length) return null;
    const from = textBoundary(spans, at, paragraph.start, length === 0 ? 'backward' : 'forward');
    const to = length === 0 ? from : textBoundary(spans, at + length, paragraph.start, 'backward');
    if ((!text && otherInline.length) || otherInline.some((inline) => inline.from < to && inline.to > from)) return null;
    const value = text.slice(at, at + length);
    const locator = JSON.stringify({
      v: 2, path, sourceId: typeof paragraph.node.attrs.paraId === 'string' ? paragraph.node.attrs.paraId : '',
      ...(container ? { container, containerId } : {}),
      at, tail: text.length - at - length,
      before: text.slice(Math.max(0, at - 128), at), after: text.slice(at + length, at + length + 128),
      textLength: value.length, textHash: bytesToHex(sha256(utf8ToBytes(value))),
    } satisfies DocxLocator);
    return locator;
  }
  function locatorForRange(editor: Editor, from: number, to: number, doc = editor.state.doc): string | null {
    const $from = doc.resolve(from), $to = doc.resolve(to);
    let depth = $from.depth;
    while (depth > 0 && $from.node(depth).type.name !== 'paragraph') depth--;
    if (!depth || $to.depth < depth || $to.node(depth) !== $from.node(depth)) return null;
    const path: ParagraphPath = [];
    for (let level = 1; level <= depth; level++) path.push({ type: $from.node(level).type.name, index: $from.index(level - 1) });
    const paragraph = paragraphAt(editor, path, doc);
    if (!paragraph) return null;
    const { spans, text, otherInline } = textSpans(paragraph.node, paragraph.start);
    if ((from === to && text !== '') || otherInline.some((inline) => inline.from < to && inline.to > from)) return null;
    const at = spans.reduce((sum, span) => sum + Math.max(0, Math.min(span.to, from) - span.from), 0);
    const selected = spans.reduce((sum, span) => sum + Math.max(0, Math.min(span.to, to) - Math.max(span.from, from)), 0);
    if (from !== to && !selected) return null;
    const $textFrom = from === to ? $from : doc.resolve(textBoundary(spans, at, paragraph.start, 'forward'));
    let container: ParagraphPath | undefined;
    for (let level = depth + 1; level <= $textFrom.depth; level++) {
      if ($textFrom.node(level).type.name === 'structuredContent') {
        container = [];
        for (let child = depth + 1; child <= level; child++) {
          container.push({ type: $textFrom.node(child).type.name, index: $textFrom.index(child - 1) });
        }
      }
    }
    return locatorForOffsets(editor, path, at, selected, container, doc);
  }
  function captureRegion(): OfficeRegionTarget | null {
    const editor = activeEditor();
    if (!editor || editor.isDestroyed) return null;
    if (editor !== runtime?.activeEditor?.getHostEditors()[0]) throw new Error('DOCX 본문 영역만 매핑할 수 있습니다.');
    const { from, to, empty, $from } = editor.state.selection;
    if (empty) {
      let depth = $from.depth;
      while (depth > 0 && $from.node(depth).type.name !== 'paragraph') depth--;
      if (!depth) return null;
      if ($from.node(depth).textContent) return null;
    }
    const locator = locatorForRange(editor, from, to);
    if (!locator) throw new Error('이 선택은 한 문단의 안전한 텍스트/빈 셀 범위가 아닙니다.');
    const target = regionTarget(locator);
    if (target.reason) throw new Error(target.reason);
    if (!target.boxes.length) throw new Error('선택 범위의 실제 DOCX 화면 위치를 확인할 수 없습니다.');
    return target;
  }
  function analyzeLoadedDocument(): SourceAnalysis {
    const editor = runtime?.activeEditor?.getHostEditors()[0];
    let counts: { sdtFields: number } | undefined;
    if (editor && !editor.isDestroyed) {
      try { counts = editor.doc.info({}).counts; } catch { /* Metrics report unavailable below. */ }
    }
    const tableReason = 'DOCX 편집기에서 본문 표 구조를 확인하지 못했습니다.';
    let nativeTableCount: CountMetric = { kind: 'unavailable', reason: tableReason };
    if (editor && !editor.isDestroyed) {
      try {
        let count = 0;
        editor.state.doc.descendants(node => { if (node.type.name === 'table') count += 1; });
        nativeTableCount = analysisCount(count, tableReason);
      } catch {
        nativeTableCount = { kind: 'unavailable', reason: tableReason };
      }
    }
    return {
      format: 'docx',
      pageCount: analysisCount(pageState().pageCount || undefined, 'DOCX 엔진에서 페이지 수를 확인하지 못했습니다.'),
      textLineCount: { kind: 'unavailable', reason: 'DOCX 텍스트 줄 수는 페이지 배치에 따라 달라져 원본 단위로 제공되지 않습니다.' },
      nativeTableCount,
      nativeFieldCount: analysisCount(counts?.sdtFields, 'DOCX 엔진에서 필드형 SDT 입력 컨트롤 수를 확인하지 못했습니다.'),
    };
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
    const editable = ready && regionMode === 'normal' && !isComposing && !protection.protectedDocument && !!editor?.isEditable && !editor.isDestroyed;
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
      ...(sourceAnalysis ? { sourceAnalysis } : {}),
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
      // The distributed SuperDoc bundle has its own ProseMirror singleton.
      // Construct the guard with the editor's native Plugin constructor.
      const PluginCtor = editor.state.plugins[0]?.constructor as new (spec: {
        filterTransaction(transaction: Transaction): boolean;
      }) => typeof editor.state.plugins[number];
      editor.registerPlugin(new PluginCtor({
        filterTransaction(transaction) {
          return (!protection.protectedDocument && regionMode === 'normal') || nativeRegionReplace ||
            (!transaction.docChanged && !transaction.storedMarksSet);
        },
      }));
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
  const onRegionInput = (event: Event) => {
    if (regionMode === 'normal' && !protection.protectedDocument) return;
    if (!surface.contains(event.target as Node)) return;
    if (regionMode === 'mapping' && (event.type === 'pointerdown' || event.type === 'click')) {
      const control = event.target instanceof Element && event.target.closest(
        'input,select,textarea,button,[role="checkbox"],[data-drag-handle],[data-resize-handle],.sd-structured-content-draggable,.column-resize-handle,.row-resize-handle',
      );
      if (!control) return; // Keep native text/cell selection available.
    }
    if (event.type === 'keydown') {
      const key = event as KeyboardEvent;
      const navigation = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Escape'].includes(key.key);
      const shortcut = (key.ctrlKey || key.metaKey) && ['a', 'c', 's', 'p'].includes(key.key.toLowerCase());
      if (regionMode === 'mapping' && (navigation || shortcut || key.key === 'Shift' || key.key === 'Control' || key.key === 'Meta')) return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
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
    for (const type of ['keydown', 'beforeinput', 'cut', 'paste', 'drop', 'dragstart', 'compositionstart', 'contextmenu', 'pointerdown', 'click']) {
      document.removeEventListener(type, onRegionInput, true);
    }
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
    for (const type of ['keydown', 'beforeinput', 'cut', 'paste', 'drop', 'dragstart', 'compositionstart', 'contextmenu', 'pointerdown', 'click']) {
      document.addEventListener(type, onRegionInput, true);
    }
    document.addEventListener('scroll', onViewport, true);
    window.addEventListener('resize', onViewport);
    document.addEventListener('load', onResource, true);
    document.fonts.addEventListener('loadingdone', invalidatePreview);
    while (!surface.querySelector('.superdoc-page')?.getBoundingClientRect().height) {
      if (startupFailure) throw startupFailure;
      await nextPaint();
    }
    await nextPaint(); await nextPaint();
    try { sourceAnalysis = analyzeLoadedDocument(); }
    catch {
      const reason = 'DOCX 문서 분석을 완료하지 못했습니다.';
      sourceAnalysis = {
        format: 'docx',
        pageCount: { kind: 'unavailable', reason },
        textLineCount: { kind: 'unavailable', reason },
        nativeTableCount: { kind: 'unavailable', reason },
        nativeFieldCount: { kind: 'unavailable', reason },
      };
    }
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
      region: {
        async targets(locators) {
          if (disposed || !ready) return [...new Set(locators)].map((locator) => targetFailure(locator, 'DOCX 세션이 닫혔습니다.'));
          return [...new Set(locators)].map(regionTarget);
        },
        async capture() {
          if (disposed || !ready || protection.protectedDocument || regionMode !== 'mapping' || composing()) return null;
          await flush();
          return captureRegion();
        },
        async replace(locator, expectedText, value, expectedRevision, locatorsToRebase) {
          if (disposed || !ready) return { ok: false, reason: 'DOCX 세션이 닫혔습니다.' };
          if (regionMode !== 'protected' || protection.protectedDocument) return { ok: false, reason: '이 문서는 보호된 영역 교체를 허용하지 않습니다.' };
          if (!Number.isSafeInteger(expectedRevision) || revision !== expectedRevision || composing()) return { ok: false, reason: '문서 버전 또는 입력 상태가 변경되었습니다.' };
          if (typeof value !== 'string' || value.includes('\r')) return { ok: false, reason: '줄바꿈은 LF 형식이어야 합니다.' };
          await flush();
          if (disposed || revision !== expectedRevision) return { ok: false, reason: '문서 버전이 변경되었습니다.' };
          if (!Array.isArray(locatorsToRebase) || !locatorsToRebase.includes(locator) ||
            new Set(locatorsToRebase).size !== locatorsToRebase.length) return { ok: false, reason: '기존 영역의 목록이 누락되었거나 중복되었습니다.' };
          const ranges = locatorsToRebase.map((entry) => resolveRegion(entry));
          const edited = resolveRegion(locator);
          if (!edited || !edited.editor.view || edited.text !== expectedText ||
            ranges.some((entry) => !entry || entry.editor !== edited.editor)) return { ok: false, reason: '원본 선택 범위나 이전 값이 변경되었습니다.' };
          const known = ranges as NonNullable<typeof edited>[];
          for (let i = 0; i < known.length; i++) {
            for (let j = i + 1; j < known.length; j++) {
              if (known[i].from < known[j].to && known[j].from < known[i].to ||
                known[i].from === known[j].from && known[i].to === known[j].to) {
                return { ok: false, reason: '원본 영역이 겹쳐 안전하게 교체할 수 없습니다.' };
              }
            }
          }
          if (edited.text === value) return { ok: true, targets: locatorsToRebase.map(regionTarget) };
          const native = edited.editor;
          const beforeDoc = native.state.doc;
          let canonical: string[] | undefined;
          let transaction: Transaction;
          try {
            if (value.includes('\n')) {
              const lines = value.split('\n');
              const marks = native.state.doc.resolve(edited.from).marksAcross(native.state.doc.resolve(edited.to)) ?? [];
              const content = lines.flatMap((line, index) => [
                ...(index ? [native.schema.nodes.lineBreak.create()] : []),
                ...(line ? [native.schema.text(line, marks)] : []),
              ]);
              transaction = native.state.tr.replaceWith(edited.from, edited.to, content);
            } else transaction = native.state.tr.insertText(value, edited.from, edited.to);
            nativeRegionReplace = true;
            // Apply to immutable PM state first, including appendTransaction hooks.
            // Reject failed rebases before dispatching anything to the live editor.
            const projected = native.state.applyTransaction(transaction);
            if (!projected.transactions.length || projected.state.doc.eq(beforeDoc)) {
              return { ok: false, reason: 'DOCX 원본 영역을 교체할 수 없습니다.' };
            }
            const editedSource = parseLocator(locator)!;
            const planned = known.map((range, index) => {
              const source = parseLocator(locatorsToRebase[index])!;
              const changed = locatorsToRebase[index] === locator;
              const sameParagraph = JSON.stringify(source.path) === JSON.stringify(editedSource.path);
              const at = source.at + (sameParagraph && source.at > editedSource.at ? value.length - expectedText.length : 0);
              const expected = changed ? value : range.text;
              const from = projected.transactions.reduce((pos, applied) => applied.mapping.map(pos, -1), range.from);
              const to = projected.transactions.reduce((pos, applied) => applied.mapping.map(pos, 1), range.to);
              let updated = locatorForRange(native, from, to, projected.state.doc);
              const mapped = updated && parseLocator(updated);
              const sameContainer = JSON.stringify(mapped?.container ?? null) === JSON.stringify(source.container ?? null) &&
                mapped?.containerId === source.containerId;
              if (mapped && sameContainer && mapped.at === at && JSON.stringify(mapped.path) === JSON.stringify(source.path) &&
                resolveRegion(updated, projected.state.doc)?.text === expected) return updated;
              // Run normalization can add PM wrappers. The source-verified
              // paragraph path and text offset remain authoritative.
              updated = locatorForOffsets(native, source.path, at, expected.length, source.container, projected.state.doc);
              return updated && resolveRegion(updated, projected.state.doc)?.text === expected ? updated : null;
            });
            if (planned.some((entry) => !entry)) return { ok: false, reason: 'DOCX 원본 영역을 다시 확인할 수 없습니다.' };
            canonical = planned as string[];
            native.view!.dispatch(transaction);
          } catch {
            if (native.state.doc.eq(beforeDoc)) return { ok: false, reason: 'DOCX 원본 영역을 교체할 수 없습니다.' };
            // A native callback failed after committing; do not report a false
            // failure that would leave the persisted mapping behind the document.
          } finally { nativeRegionReplace = false; }
          if (revision === expectedRevision) revision++;
          publish();
          await nextPaint(); await nextPaint();
          return { ok: true, targets: canonical!.map(regionTarget) };
        },
        async highlight(locator) {
          if (disposed || !ready) return { ok: false, reason: 'DOCX 세션이 닫혔습니다.' };
          const resolved = resolveRegion(locator);
          if (!resolved || !resolved.editor.view) return { ok: false, reason: '원본 선택 범위를 찾을 수 없거나 문서에서 잠겼습니다.' };
          if (!resolved.editor.commands.setTextSelection({ from: resolved.from, to: resolved.to })) return { ok: false, reason: '원본 선택 범위를 표시할 수 없습니다.' };
          resolved.editor.presentationEditor?.scrollToPosition(resolved.from, { block: 'center', behavior: 'auto' });
          onViewport(); publish();
          return { ok: true };
        },
        async scroll(dx, dy) {
          if (disposed || !ready || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
          document.scrollingElement?.scrollBy({ left: dx, top: dy, behavior: 'instant' });
          onViewport();
          await nextPaint();
        },
        async setMode(mode) {
          if (disposed || regionMode === mode) return;
          regionMode = mode;
          bookmark = undefined;
          surface.inert = mode === 'protected';
          runtime.setDocumentMode(mode === 'protected' || protection.protectedDocument ? 'viewing' : 'editing');
          selectionCache = undefined;
          publish();
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

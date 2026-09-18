import * as mupdf from 'mupdf';
import type { Page } from '../types/pdfEditor';
import type { DuplicateCapability, SourceInfo } from './engineTypes';

type Obj = mupdf.PDFObject;

// Every temporary wrapper is owned here; returned page references belong to the caller.
class Objects {
  private values: Obj[] = [];
  own(value: Obj): Obj { if (value !== mupdf.PDFObject.Null) this.values.push(value); return value; }
  get(value: Obj, ...path: (string | number)[]): Obj { return this.own(value.get(...path)); }
  entries(value: Obj): Array<[string | number, Obj]> {
    const entries: Array<[string | number, Obj]> = [];
    value.forEach((child, key) => entries.push([key, this.own(child)]));
    return entries;
  }
  close(): void { for (let i = this.values.length - 1; i >= 0; --i) this.values[i].destroy(); }
}

function identity(value: Obj): string {
  return value.isIndirect() ? `r${value.asIndirect()}` : `p${value.pointer}`;
}
function same(a: Obj, b: Obj): boolean { return identity(a) === identity(b); }
function name(objects: Objects, value: Obj, key: string): string { return objects.get(value, key).asName(); }
function inherited(objects: Objects, value: Obj, key: string): Obj {
  const seen = new Set<string>();
  while (!value.isNull() && !seen.has(identity(value))) {
    seen.add(identity(value));
    const found = objects.get(value, key);
    if (!found.isNull()) return found;
    value = objects.get(value, 'Parent');
  }
  return mupdf.PDFObject.Null;
}

export function getDuplicateCapability(pdf: mupdf.PDFDocument, pageIndex: number): DuplicateCapability {
  const objects = new Objects();
  try {
    const root = objects.get(objects.own(pdf.getTrailer()), 'Root');
    if (!objects.get(root, 'AcroForm', 'XFA').isNull()) {
      return { allowed: false, code: 'XFA', reason: 'XFA 양식 페이지는 독립적으로 복제할 수 없습니다.' };
    }
    const page = objects.own(pdf.findPage(pageIndex));
    for (const [, annot] of objects.entries(objects.get(page, 'Annots'))) {
      if (name(objects, annot, 'Subtype') === 'Widget' && inherited(objects, annot, 'FT').asName() === 'Sig') {
        return { allowed: false, code: 'SIGNATURE', reason: '인증서 서명 필드가 있는 페이지는 복제할 수 없습니다.' };
      }
    }
    return { allowed: true };
  } finally { objects.close(); }
}

export function hasDocumentSignatures(pdf: mupdf.PDFDocument): boolean {
  const objects = new Objects();
  try {
    const root = objects.get(objects.own(pdf.getTrailer()), 'Root');
    const seen = new Set<string>();
    const visit = (field: Obj): boolean => {
      if (seen.has(identity(field))) return false;
      seen.add(identity(field));
      if (inherited(objects, field, 'FT').asName() === 'Sig') return true;
      return objects.entries(objects.get(field, 'Kids')).some(([, child]) => visit(child));
    };
    if (objects.entries(objects.get(root, 'AcroForm', 'Fields')).some(([, field]) => visit(field))) return true;
    for (let i = 0; i < pdf.countPages(); ++i) {
      const page = objects.own(pdf.findPage(i));
      if (objects.entries(objects.get(page, 'Annots')).some(([, annot]) =>
        name(objects, annot, 'Subtype') === 'Widget' && inherited(objects, annot, 'FT').asName() === 'Sig')) return true;
    }
    return false;
  } finally { objects.close(); }
}

// Containers are private, immutable indirect resources/streams remain shared.
function copyContainers(pdf: mupdf.PDFDocument, objects: Objects, value: Obj, remap: Map<string, Obj>, resolve = false): Obj {
  const mapped = remap.get(identity(value));
  if (mapped && !resolve) return mapped;
  if (value.isStream() || (value.isIndirect() && !resolve)) return value;
  if (!value.isArray() && !value.isDictionary()) return value;
  const result = objects.own(value.isArray() ? pdf.newArray() : pdf.newDictionary());
  for (const [key, child] of objects.entries(value)) result.put(key, copyContainers(pdf, objects, child, remap));
  return result;
}

function copyAction(pdf: mupdf.PDFDocument, objects: Objects, value: Obj, remap: Map<string, Obj>): Obj {
  const mapped = remap.get(identity(value));
  if (mapped) return mapped;
  if (value.isStream() || (!value.isArray() && !value.isDictionary())) return value;
  if (value.isDictionary() && name(objects, value, 'Type') === 'Page') return value;
  const container = objects.own(value.isArray() ? pdf.newArray() : pdf.newDictionary());
  const result = value.isIndirect() ? objects.own(pdf.addObject(container)) : container;
  remap.set(identity(value), result);
  for (const [key, child] of objects.entries(value)) {
    result.put(key, key === 'D' && name(objects, value, 'S') === 'GoTo'
      ? copyDestination(pdf, objects, child, remap)
      : copyAction(pdf, objects, child, remap));
  }
  return result;
}

function copyDestination(pdf: mupdf.PDFDocument, objects: Objects, destination: Obj, remap: Map<string, Obj>): Obj {
  const named = new Set<string>();
  while (destination.isName() || destination.isString() || destination.isDictionary()) {
    if (destination.isDictionary()) { destination = objects.get(destination, 'D'); continue; }
    const key = destination.isString() ? destination.asString() : destination.asName();
    if (named.has(key)) throw new Error('PDF 목적지 이름이 순환합니다.');
    named.add(key);
    const catalog = objects.get(objects.own(pdf.getTrailer()), 'Root');
    let found = objects.get(catalog, 'Dests', key);
    if (found.isNull()) {
      const visited = new Set<string>();
      const search = (node: Obj): Obj => {
        if (node.isNull() || visited.has(identity(node))) return mupdf.PDFObject.Null;
        visited.add(identity(node));
        const entries = objects.get(node, 'Names');
        for (let i = 0; i + 1 < entries.length; i += 2) {
          if (objects.get(entries, i).asString() === key) return objects.get(entries, i + 1);
        }
        for (const [, child] of objects.entries(objects.get(node, 'Kids'))) {
          const match = search(child);
          if (!match.isNull()) return match;
        }
        return mupdf.PDFObject.Null;
      };
      found = search(objects.get(catalog, 'Names', 'Dests'));
    }
    if (found.isNull()) return destination;
    destination = found;
  }
  const result = copyAction(pdf, objects, destination, remap);
  if (result.isArray() && result.length) {
    const target = objects.get(result, 0);
    if (target.isInteger() && target.asNumber() >= 0 && target.asNumber() < pdf.countPages()) {
      const ref = objects.own(pdf.findPage(target.asNumber()));
      result.put(0, remap.get(identity(ref)) ?? ref);
    }
  }
  return result;
}

function materializeInheritance(pdf: mupdf.PDFDocument, objects: Objects, page: Obj): void {
  for (const key of ['MediaBox', 'CropBox', 'Rotate', 'Resources']) {
    const value = objects.own(page.getInheritable(key));
    if (!value.isNull()) page.put(key, copyContainers(pdf, objects, value, new Map(), true));
  }
}

function clonePage(pdf: mupdf.PDFDocument, objects: Objects, source: Obj, pageId: string): Obj {
  const result = objects.own(pdf.addObject(objects.own(pdf.newDictionary())));
  const remap = new Map<string, Obj>([[identity(source), result]]);
  const annotations = objects.entries(objects.get(source, 'Annots')).map(([, value]) => value);
  const nodes = new Map<string, Obj>();
  const fields = new Set<string>();
  for (const annot of annotations) nodes.set(identity(annot), annot);
  // Popup/reply dictionaries may be reachable only from another annotation.
  for (const annot of nodes.values()) {
    if (name(objects, annot, 'Subtype') === 'Widget') continue;
    for (const key of ['Popup', 'Parent', 'IRT']) {
      const related = objects.get(annot, key);
      if (related.isNull() || !related.isDictionary() || objects.get(related, 'Subtype').isNull()) continue;
      const owner = objects.get(related, 'P');
      if (owner.isNull() || same(owner, source)) nodes.set(identity(related), related);
    }
  }
  for (const annot of annotations) {
    if (name(objects, annot, 'Subtype') !== 'Widget') continue;
    let field = annot;
    const seen = new Set<string>();
    while (!field.isNull()) {
      const id = identity(field);
      if (seen.has(id)) throw new Error('양식 필드의 Parent 관계가 순환합니다.');
      seen.add(id); fields.add(id); nodes.set(id, field);
      field = objects.get(field, 'Parent');
    }
  }
  // A single map covers merged widget/field dictionaries and all local relations.
  for (const id of nodes.keys()) remap.set(id, objects.own(pdf.addObject(objects.own(pdf.newDictionary()))));
  for (const [key, value] of objects.entries(source)) {
    if (key === 'Parent' || key === 'Annots' || key === 'StructParents') continue;
    result.put(key, copyContainers(pdf, objects, value, remap));
  }
  const roots: Obj[] = [];
  for (const [id, original] of nodes) {
    const clone = remap.get(id)!;
    for (const [key, value] of objects.entries(original)) {
      if (key === 'P' || key === 'StructParent' || (fields.has(id) && (key === 'Kids' || key === 'Parent'))) continue;
      clone.put(key, key === 'Dest' ? copyDestination(pdf, objects, value, remap)
        : key === 'A' || key === 'AA' ? copyAction(pdf, objects, value, remap)
        : copyContainers(pdf, objects, value, remap));
    }
    if (!fields.has(id) || name(objects, original, 'Subtype') === 'Widget') clone.put('P', result);
    if (fields.has(id)) {
      const parent = objects.get(original, 'Parent');
      if (!parent.isNull()) {
        const mappedParent = remap.get(identity(parent));
        if (!mappedParent) throw new Error('복제할 양식 상위 필드를 찾지 못했습니다.');
        clone.put('Parent', mappedParent);
      } else {
        roots.push(clone);
        clone.put('T', objects.own(pdf.newString(`copy_${pageId}_${objects.get(original, 'T').asString()}`)));
      }
      const originalKids = objects.get(original, 'Kids');
      if (originalKids.isArray()) {
        const kids = objects.own(pdf.newArray());
        for (const [, child] of objects.entries(originalKids)) {
          const mapped = remap.get(identity(child));
          if (mapped) kids.push(mapped);
        }
        clone.put('Kids', kids);
      }
    }
  }
  if (annotations.length) {
    const annots = objects.own(pdf.newArray());
    for (const annot of annotations) annots.push(remap.get(identity(annot))!);
    result.put('Annots', annots);
  }
  if (roots.length) {
    const catalog = objects.get(objects.own(pdf.getTrailer()), 'Root');
    const form = objects.get(catalog, 'AcroForm');
    if (form.isNull()) throw new Error('위젯의 AcroForm을 찾지 못했습니다.');
    const fieldList = objects.own(pdf.newArray());
    for (const [, field] of objects.entries(objects.get(form, 'Fields'))) fieldList.push(field);
    for (const field of roots) fieldList.push(field);
    form.put('Fields', fieldList);
    const oldOrder = objects.get(form, 'CO');
    if (oldOrder.isArray()) {
      const order = objects.own(pdf.newArray());
      for (const [, field] of objects.entries(oldOrder)) order.push(field);
      for (const [, field] of objects.entries(oldOrder)) {
        const mapped = remap.get(identity(field));
        if (mapped) order.push(mapped);
      }
      form.put('CO', order);
    }
  }
  pdf.insertPage(-1, result);
  return pdf.findPage(pdf.countPages() - 1);
}

export function findPageIndex(pdf: mupdf.PDFDocument, ref: Obj): number {
  for (let i = 0; i < pdf.countPages(); ++i) {
    const page = pdf.findPage(i);
    try { if (same(page, ref)) return i; } finally { page.destroy(); }
  }
  return -1;
}

export function preparePageInstances(pdf: mupdf.PDFDocument, pages: Page[], sourceInfo: SourceInfo): { refs: Obj[]; originalRefs: Obj[] } {
  const objects = new Objects();
  const originalRefs: Obj[] = [];
  const refs: Obj[] = [];
  try {
    if (!pages.length) throw new Error('문서에는 한 페이지 이상이 필요합니다.');
    if (pdf.countPages() !== sourceInfo.pages.length) throw new Error('원본 페이지 정보가 일치하지 않습니다.');
    const originals = new Set<number>();
    const ids = new Set<string>();
    for (const page of pages) {
      if (ids.has(page.id)) throw new Error('중복 페이지 ID입니다.');
      ids.add(page.id);
      if (page.kind === 'pdf') {
        if (!Number.isInteger(page.sourcePageIndex) || !sourceInfo.pages[page.sourcePageIndex]) throw new Error('원본 페이지 참조가 유효하지 않습니다.');
        if (page.originalInstance) {
          if (originals.has(page.sourcePageIndex)) throw new Error('원본 페이지 인스턴스가 중복되었습니다.');
          originals.add(page.sourcePageIndex);
        } else {
          if (!pdf.hasPermission('copy')) throw new Error('이 PDF는 페이지를 복사할 권한이 없습니다.');
          const capability = getDuplicateCapability(pdf, page.sourcePageIndex);
          if (!capability.allowed) throw Object.assign(new Error(capability.reason), { code: capability.code });
        }
      } else if (!(Number.isFinite(page.widthPt) && Number.isFinite(page.heightPt) && page.widthPt > 0 && page.heightPt > 0)) {
        throw new Error('빈 페이지 크기가 유효하지 않습니다.');
      }
    }
    const structuralChange = pages.length !== pdf.countPages() || pages.some((page, i) =>
      page.kind !== 'pdf' || !page.originalInstance || page.sourcePageIndex !== i || page.rotation !== 0);
    if (structuralChange && !pdf.hasPermission('assemble')) throw new Error('이 PDF는 페이지 구성을 변경할 권한이 없습니다.');
    for (let i = 0; i < pdf.countPages(); ++i) {
      const ref = pdf.findPage(i); originalRefs.push(ref);
      materializeInheritance(pdf, objects, ref);
    }
    for (const page of pages) {
      if (page.kind === 'blank') {
        const ref = objects.own(pdf.addPage([0, 0, page.widthPt, page.heightPt], 0, objects.own(pdf.newDictionary()), ''));
        pdf.insertPage(-1, ref); refs.push(pdf.findPage(pdf.countPages() - 1));
      } else if (page.originalInstance) refs.push(pdf.findPage(page.sourcePageIndex));
      else refs.push(clonePage(pdf, objects, originalRefs[page.sourcePageIndex], page.id));
    }
    return { refs, originalRefs };
  } catch (error) {
    for (const ref of refs) ref.destroy();
    for (const ref of originalRefs) ref.destroy();
    throw error;
  } finally { objects.close(); }
}

function removeDeletedFields(pdf: mupdf.PDFDocument, objects: Objects, deletedPages: Obj[]): void {
  const removed = new Set<string>();
  for (const page of deletedPages) for (const [, annot] of objects.entries(objects.get(page, 'Annots'))) {
    if (name(objects, annot, 'Subtype') === 'Widget') removed.add(identity(annot));
  }
  const form = objects.get(objects.own(pdf.getTrailer()), 'Root', 'AcroForm');
  if (form.isNull()) return;
  const visiting = new Set<string>();
  const prune = (field: Obj): boolean => {
    const id = identity(field);
    if (removed.has(id)) return false;
    if (visiting.has(id)) throw new Error('양식 필드 Kids 관계가 순환합니다.');
    visiting.add(id);
    const kids = objects.get(field, 'Kids');
    if (kids.isArray() && kids.length) {
      const next = objects.own(pdf.newArray());
      for (const [, child] of objects.entries(kids)) if (prune(child)) next.push(child);
      if (!next.length) { removed.add(id); visiting.delete(id); return false; }
      if (next.length !== kids.length) field.put('Kids', next);
    }
    visiting.delete(id);
    return true;
  };
  const fields = objects.own(pdf.newArray());
  for (const [, field] of objects.entries(objects.get(form, 'Fields'))) if (prune(field)) fields.push(field);
  form.put('Fields', fields);
  const order = objects.get(form, 'CO');
  if (order.isArray()) {
    const kept = objects.own(pdf.newArray());
    for (const [, field] of objects.entries(order)) if (!removed.has(identity(field))) kept.push(field);
    form.put('CO', kept);
  }
}

function cleanDestinations(pdf: mupdf.PDFDocument, objects: Objects, kept: Set<string>, originalRefs: Obj[]): void {
  const catalog = objects.get(objects.own(pdf.getTrailer()), 'Root');
  const removedNames = new Set<string>();
  const destinationName = (value: Obj): string => value.isString() ? value.asString() : value.asName();
  const valid = (destination: Obj): boolean => {
    if (destination.isDictionary()) return valid(objects.get(destination, 'D'));
    if (destination.isName() || destination.isString()) return !removedNames.has(destinationName(destination));
    if (!destination.isArray() || !destination.length) return false;
    const target = objects.get(destination, 0);
    if (target.isInteger()) {
      const ref = originalRefs[target.asNumber()];
      if (!ref || !kept.has(identity(ref))) return false;
      destination.put(0, ref);
      return true;
    }
    return kept.has(identity(target));
  };
  const oldDests = objects.get(catalog, 'Dests');
  for (const [key, destination] of objects.entries(oldDests)) {
    if (!valid(destination)) { removedNames.add(String(key)); oldDests.delete(key); }
  }
  const visitedNames = new Set<string>();
  const pruneNames = (node: Obj): void => {
    if (node.isNull() || visitedNames.has(identity(node))) return;
    visitedNames.add(identity(node));
    const names = objects.get(node, 'Names');
    if (names.isArray()) {
      const next = objects.own(pdf.newArray());
      for (let i = 0; i + 1 < names.length; i += 2) {
        const key = objects.get(names, i); const destination = objects.get(names, i + 1);
        if (valid(destination)) { next.push(key); next.push(destination); }
        else removedNames.add(destinationName(key));
      }
      node.put('Names', next);
      if (next.length) {
        const limits = objects.own(pdf.newArray()); limits.push(objects.get(next, 0)); limits.push(objects.get(next, next.length - 2)); node.put('Limits', limits);
      } else node.delete('Limits');
    }
    for (const [, child] of objects.entries(objects.get(node, 'Kids'))) pruneNames(child);
    // Conservative original internal-node limits still enclose every retained key.
  };
  pruneNames(objects.get(catalog, 'Names', 'Dests'));
  const visited = new Set<string>();
  const walk = (value: Obj): void => {
    if ((!value.isArray() && !value.isDictionary()) || value.isStream() || visited.has(identity(value))) return;
    visited.add(identity(value));
    if (value.isDictionary()) {
      const dest = objects.get(value, 'Dest');
      if (!dest.isNull() && !valid(dest)) value.delete('Dest');
      if (name(objects, value, 'S') === 'GoTo') {
        const target = objects.get(value, 'D');
        if (!target.isNull() && !valid(target)) { value.delete('D'); value.delete('S'); }
      }
    }
    for (const [key, child] of objects.entries(value)) {
      if (key !== 'Parent' && key !== 'P' && key !== 'Resources' && key !== 'Contents') walk(child);
    }
  };
  walk(catalog);
}

function validateWidgetPages(pdf: mupdf.PDFDocument, objects: Objects, refs: Obj[]): void {
  const kept = new Set(refs.map(identity));
  const widgetIds = new Set<string>();
  for (const page of refs) for (const [, annot] of objects.entries(objects.get(page, 'Annots'))) {
    if (name(objects, annot, 'Subtype') !== 'Widget') continue;
    if (widgetIds.has(identity(annot))) throw new Error('위젯이 페이지 Annots에 중복 연결되어 있습니다.');
    widgetIds.add(identity(annot));
    const owner = objects.get(annot, 'P');
    if (!owner.isNull() && !same(owner, page)) throw new Error('위젯의 페이지 참조가 실제 페이지와 다릅니다.');
  }
  const seen = new Set<string>();
  const visit = (field: Obj, expectedParent: Obj | null): void => {
    if (seen.has(identity(field))) throw new Error('양식 필드가 중복 연결되었거나 Kids 관계가 순환합니다.');
    seen.add(identity(field));
    const parent = objects.get(field, 'Parent');
    if (expectedParent ? !same(parent, expectedParent) : !parent.isNull()) {
      throw new Error('양식 필드의 Parent와 Kids 관계가 일치하지 않습니다.');
    }
    if (name(objects, field, 'Subtype') === 'Widget') {
      const page = objects.get(field, 'P');
      if ((!page.isNull() && !kept.has(identity(page))) || !widgetIds.has(identity(field))) throw new Error('양식에 삭제된 페이지 위젯이 남아 있습니다.');
    }
    for (const [, child] of objects.entries(objects.get(field, 'Kids'))) visit(child, field);
  };
  for (const [, field] of objects.entries(objects.get(objects.own(pdf.getTrailer()), 'Root', 'AcroForm', 'Fields'))) visit(field, null);
  for (const widgetId of widgetIds) {
    if (!seen.has(widgetId)) throw new Error('페이지 위젯이 AcroForm.Fields에 연결되어 있지 않습니다.');
  }
}

export function finalizePageInstances(pdf: mupdf.PDFDocument, pages: Page[], refs: Obj[], originalRefs: Obj[]): void {
  const objects = new Objects();
  try {
    if (!pages.length || pages.length !== refs.length || new Set(refs.map(identity)).size !== refs.length) throw new Error('페이지 인스턴스 구성이 유효하지 않습니다.');
    const kept = new Set(refs.map(identity));
    const deletedPages = originalRefs.filter(ref => !kept.has(identity(ref)));
    removeDeletedFields(pdf, objects, deletedPages);
    cleanDestinations(pdf, objects, kept, originalRefs);
    // Reordering uses the original indirect page references, never aliases/grafts.
    for (let target = 0; target < refs.length; ++target) {
      const current = findPageIndex(pdf, refs[target]);
      if (current < 0) throw new Error('출력할 페이지를 찾지 못했습니다.');
      if (current !== target) {
        materializeInheritance(pdf, objects, refs[target]);
        pdf.deletePage(current); pdf.insertPage(target, refs[target]);
      }
    }
    while (pdf.countPages() > refs.length) pdf.deletePage(pdf.countPages() - 1);
    validateWidgetPages(pdf, objects, refs);
  } finally { objects.close(); }
}

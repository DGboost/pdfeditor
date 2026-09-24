import type { DocumentFormat } from './formats';
import { sha256Hex } from '../utils/crypto';

const hashes = new WeakMap<Blob, Promise<string>>();

export function hashSource(source: Blob): Promise<string> {
  const cached = hashes.get(source);
  if (cached) return cached;
  const pending = source.arrayBuffer().then(bytes => sha256Hex(new Uint8Array(bytes))).catch(error => {
    hashes.delete(source);
    throw error;
  });
  hashes.set(source, pending);
  return pending;
}

export function modifiedFileName(fileName: string, format: DocumentFormat): string {
  const base = fileName.replace(/\.(?:pdf|docx|hwp|hwpx|pptx|doc|ppt)$/i, '').trim() || '문서';
  return `${base}_수정본.${format}`;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

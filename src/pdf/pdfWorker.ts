import * as pdfjsLib from 'pdfjs-dist';
// Vite serves this as a fingerprinted, same-origin static asset — this replaces the old
// prototype's manual "fetch a CDN worker script as text -> Blob -> createObjectURL" workaround,
// which only existed to dodge a cross-origin classic-Worker SecurityError.
// eslint-disable-next-line import/no-unresolved
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export { pdfjsLib };

import { useCallback, useRef, useState } from 'react';

export function useSignatureCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const [hasStrokes, setHasStrokes] = useState(false);

  const setCanvasRef = useCallback((el: HTMLCanvasElement | null) => {
    canvasRef.current = el;
    if (!el) return;
    const ctx = el.getContext('2d')!;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1a2b4c';
    ctxRef.current = ctx;
    let drawing = false;
    const pos = (e: PointerEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      const scaleX = el.width / r.width, scaleY = el.height / r.height;
      return [(e.clientX - r.left) * scaleX, (e.clientY - r.top) * scaleY];
    };
    el.onpointerdown = (e) => {
      drawing = true;
      const [x, y] = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      setHasStrokes(true);
    };
    el.onpointermove = (e) => { if (!drawing) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); };
    el.onpointerup = () => { drawing = false; };
    el.onpointerleave = () => { drawing = false; };
  }, []);

  const clear = useCallback(() => {
    if (ctxRef.current && canvasRef.current) ctxRef.current.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    setHasStrokes(false);
  }, []);

  const reset = useCallback(() => setHasStrokes(false), []);

  const getDataUrl = useCallback((): string | null => {
    if (!canvasRef.current || !hasStrokes) return null;
    return canvasRef.current.toDataURL('image/png');
  }, [hasStrokes]);

  return { setCanvasRef, hasStrokes, clear, reset, getDataUrl };
}

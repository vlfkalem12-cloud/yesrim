import { VIEWPORT, type Color, type Insets } from './types';

export function isViewportDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= VIEWPORT.minDimension && value <= VIEWPORT.maxDimension;
}

export function number(value: string | number, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
export function clamp(value: number, min = 0, max = 100000): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
export function readInsets(style: CSSStyleDeclaration, prefix: 'padding' | 'margin' | 'border'): Insets {
  const suffix = prefix === 'border' ? '-width' : '';
  const read = (side: string) => number(style.getPropertyValue(`${prefix}-${side}${suffix}`));
  return { top: read('top'), right: read('right'), bottom: read('bottom'), left: read('left') };
}
/** Computed styles normally return rgb()/rgba(). Support modern space-separated forms too. */
export function parseColor(value: string): Color | null {
  if (!value || value === 'transparent') return null;
  if (value.startsWith('#')) {
    const raw = value.slice(1);
    const hex = raw.length <= 4 ? [...raw].map(c => c + c).join('') : raw;
    if (!/^[\da-f]{6}([\da-f]{2})?$/i.test(hex)) return null;
    return { r: parseInt(hex.slice(0, 2), 16) / 255, g: parseInt(hex.slice(2, 4), 16) / 255, b: parseInt(hex.slice(4, 6), 16) / 255, a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1 };
  }
  const match = value.match(/^rgba?\((.*)\)$/i);
  if (!match) return null;
  const values = match[1]!.replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
  const channel = (v: string) => clamp(number(v) / (v.endsWith('%') ? 100 : 255), 0, 1);
  return { r: channel(values[0] ?? '0'), g: channel(values[1] ?? '0'), b: channel(values[2] ?? '0'), a: clamp(number(values[3] ?? '1') / (values[3]?.endsWith('%') ? 100 : 1), 0, 1) };
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

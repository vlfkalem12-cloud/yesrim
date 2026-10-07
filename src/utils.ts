import { VIEWPORT, type Color, type Insets, type ParsedShadow } from './types';

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
  const match = value.match(/^(?:rgba?|hsla?)\((.*)\)$/i);
  if (!match) return null;
  const values = match[1]!.replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
  if (values.length < 3 || values.length > 4 || values.some(v => !Number.isFinite(parseFloat(v)))) return null;
  const alpha = clamp(number(values[3] ?? '1') / (values[3]?.endsWith('%') ? 100 : 1), 0, 1);
  if (/^hsl/i.test(value)) {
    const hue = values[0]!;
    const degrees = number(hue) * (hue.endsWith('turn') ? 360 : hue.endsWith('rad') ? 180 / Math.PI : hue.endsWith('grad') ? .9 : 1);
    const h = ((degrees % 360) + 360) % 360 / 60;
    const s = clamp(number(values[1]!) / 100, 0, 1), l = clamp(number(values[2]!) / 100, 0, 1);
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
    const channels = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return { r: channels[0]! + m, g: channels[1]! + m, b: channels[2]! + m, a: alpha };
  }
  const channel = (v: string) => clamp(number(v) / (v.endsWith('%') ? 100 : 255), 0, 1);
  return { r: channel(values[0] ?? '0'), g: channel(values[1] ?? '0'), b: channel(values[2] ?? '0'), a: alpha };
}
export function splitCSSList(value: string): string[] {
  const parts: string[] = []; let depth = 0, quote = '', start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quote) { if (char === quote && value[i - 1] !== '\\') quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') depth++; else if (char === ')') depth--; else if (char === ',' && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(value.slice(start).trim()); return parts;
}
export function parseShadow(value: string): ParsedShadow | undefined {
  if (!value || value === 'none') return undefined;
  const first = splitCSSList(value)[0]!;
  const colorString = first.match(/(?:rgba?|hsla?)\([^)]*\)|#[\da-f]{3,8}/i)?.[0];
  const color = colorString ? parseColor(colorString) : null;
  const numbers = first.replace(colorString || '', '').replace(/\binset\b/g, '').trim().split(/\s+/).map(v => number(v, NaN));
  if (!color || numbers.length < 2 || numbers.some(v => !Number.isFinite(v))) return undefined;
  return { color, x: numbers[0]!, y: numbers[1]!, blur: Math.max(0, numbers[2] || 0), spread: numbers[3] || 0, inset: /\binset\b/.test(first) };
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

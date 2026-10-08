import type { Color, ParsedGradient } from './types';
import { parseColor, splitCSSList } from './utils';

interface GradientResult { gradient?: ParsedGradient; fallback: Color | null; warning?: string }
const colorToken = /#[\da-f]+\b|(?:rgba?|hsla?)\([^)]*\)|\btransparent\b/gi;
const readColor = (value: string) => value.toLowerCase() === 'transparent' ? { r: 0, g: 0, b: 0, a: 0 } : parseColor(value);

/** Parse the supported subset, preserving a usable color even when other syntax is unsupported. */
export function parseLinearGradient(value: string): GradientResult {
  const fallback = [...value.matchAll(colorToken)].map(match => readColor(match[0])).find(color => color !== null) ?? null;
  const fail = (reason: string): GradientResult => ({ fallback, warning: `Linear Gradient 처리 실패 (${reason}). ${fallback ? '첫 번째 유효 color stop을 Solid Fill로 사용합니다.' : '유효 color stop이 없어 기존 배경색을 유지합니다.'}` });
  const match = value.match(/^linear-gradient\(([\s\S]*)\)$/i);
  if (!match) return fail('지원하지 않는 문법');
  const parts = splitCSSList(match[1]!);
  let angle: ParsedGradient['angle'] = 180;
  const first = parts[0] || '';
  if (!/^(?:#|rgba?\(|hsla?\(|transparent\b)/i.test(first)) {
    parts.shift();
    const directions: Record<string, ParsedGradient['angle']> = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 };
    const degrees = first.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))deg$/i);
    const parsed = degrees ? ((Number(degrees[1]) % 360) + 360) % 360 : directions[first.toLowerCase()];
    if (parsed !== 0 && parsed !== 90 && parsed !== 180 && parsed !== 270) return fail('지원 각도: 0 / 90 / 180 / 270deg');
    angle = parsed;
  }
  const stops: { color: Color; position: number | null }[] = [];
  for (const part of parts) {
    const token = part.match(/^(#[\da-f]+|(?:rgba?|hsla?)\([^)]*\)|transparent)(?=\s|$)/i);
    const color = token ? readColor(token[1]!) : null;
    if (!color) return fail('지원하지 않는 color stop');
    const tail = part.slice(token![0].length).trim();
    const percent = tail.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))%$/);
    if (tail && !percent) return fail('color stop은 percentage 또는 생략만 지원');
    const position = percent ? Number(percent[1]) / 100 : null;
    if (position !== null && (!Number.isFinite(position) || position < 0 || position > 1)) return fail('percentage 범위는 0~100%');
    stops.push({ color, position });
  }
  if (stops.length < 2) return fail('2개 이상의 color stop 필요');
  stops[0]!.position ??= 0;
  stops[stops.length - 1]!.position ??= 1;
  // CSS clamps decreasing explicit stops, then distributes runs of unspecified stops.
  let previous = 0;
  for (const stop of stops) if (stop.position !== null) { stop.position = Math.max(previous, stop.position); previous = stop.position; }
  let anchor = 0;
  for (let index = 1; index < stops.length; index++) {
    if (stops[index]!.position === null) continue;
    const start = stops[anchor]!.position!, end = stops[index]!.position!;
    for (let missing = anchor + 1; missing < index; missing++) stops[missing]!.position = start + (end - start) * (missing - anchor) / (index - anchor);
    anchor = index;
  }
  return { gradient: { angle, stops: stops.map(stop => ({ color: stop.color, position: stop.position! })), layerIndex: 0 }, fallback };
}

/** Figma's matrix maps node coordinates into the horizontal gradient's unit space. */
export function linearGradientPaint(gradient: ParsedGradient): GradientPaint {
  const transforms: Record<ParsedGradient['angle'], Transform> = {
    0: [[0, -1, 1], [1, 0, 0]], 90: [[1, 0, 0], [0, 1, 0]],
    180: [[0, 1, 0], [-1, 0, 1]], 270: [[-1, 0, 1], [0, -1, 1]]
  };
  // RGB at alpha 0 is invisible in CSS premultiplied interpolation. Give it adjacent colors
  // so SVG/Figma interpolation cannot introduce black fringes around transparent grid lines.
  const nextColors: (Color | undefined)[] = [];
  let next: Color | undefined;
  for (let index = gradient.stops.length - 1; index >= 0; index--) {
    if (gradient.stops[index]!.color.a > 0) next = gradient.stops[index]!.color;
    nextColors[index] = next;
  }
  const stops: ColorStop[] = [];
  let previous: Color | undefined;
  gradient.stops.forEach((stop, index) => {
    if (stop.color.a > 0) { previous = stop.color; stops.push(stop); return; }
    const before = previous || nextColors[index] || stop.color, after = nextColors[index] || before;
    stops.push({ position: stop.position, color: { ...before, a: 0 } });
    // Different colors fade into/out of the same transparent position without a visible color seam.
    if (before.r !== after.r || before.g !== after.g || before.b !== after.b) stops.push({ position: stop.position, color: { ...after, a: 0 } });
  });
  return { type: 'GRADIENT_LINEAR', gradientTransform: transforms[gradient.angle], gradientStops: stops, opacity: 1, visible: true, blendMode: 'NORMAL' };
}

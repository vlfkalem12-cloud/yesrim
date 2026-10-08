import { readInsets } from './utils';

/** Require a complete clipping pattern as well as tiny size; size and class names alone are insufficient. */
export function isAccessibilityHidden(style: CSSStyleDeclaration): boolean {
  if (!['absolute', 'fixed'].includes(style.position) || style.display === 'contents') return false;
  const width = parseFloat(style.width), height = parseFloat(style.height);
  const tiny = (Number.isFinite(width) && width <= 1) || (Number.isFinite(height) && height <= 1);
  if (!tiny) return false;
  const overflowHidden = [style.overflowX, style.overflowY].every(value => ['hidden', 'clip'].includes(value));
  const compactSpacing = style.whiteSpace === 'nowrap' && Object.values(readInsets(style, 'margin')).some(value => value < 0) &&
    [readInsets(style, 'padding'), readInsets(style, 'border')].every(insets => Object.values(insets).every(value => value === 0));
  const rect = style.clip.match(/^rect\((.*)\)$/i);
  if (rect) {
    const sides = rect[1]!.trim().split(/[\s,]+/);
    if (sides.length === 4 && sides.every(side => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/.test(side))) {
      const [top, right, bottom, left] = sides.map(parseFloat) as [number, number, number, number];
      if (bottom <= top || right <= left) return overflowHidden || compactSpacing;
    }
  }
  const inset = style.clipPath.match(/^inset\(([^)]*)\)$/i);
  if (!inset) return false;
  const sides = inset[1]!.split(/\s+round\s+/i)[0]!.trim().split(/\s+/);
  if (!sides.length || sides.length > 4 || !sides.every(side => /^\d+(?:\.\d+)?%$/.test(side))) return false;
  const values = sides.map(parseFloat);
  const top = values[0]!, right = values[1] ?? top, bottom = values[2] ?? top, left = values[3] ?? right;
  return top + bottom >= 100 || left + right >= 100;
}

import type { Bounds, ParsedNode, ParsedStyle, ParsedTextRange, ParsedTextStyle } from './types';
import { hasInlineBoxStyle } from './inline-layout';
import { isSingleTextLine } from './sizing';
import { number, readInsets } from './utils';

const INLINE_STYLES = new Set(['b', 'strong', 'em', 'i', 'u', 'small', 'span']);
const zero = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
export const textStyle = (style: ParsedStyle): ParsedTextStyle => ({
  fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle,
  color: style.color, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, textDecoration: style.textDecoration
});
interface TextSource { node: Text | Element; text: string; style: ParsedTextStyle; transform: string; inline: boolean }
export interface RichTextRun { text: string; ranges: ParsedTextRange[]; rect: Bounds; firstX: number; singleLine: boolean; merge: boolean }
export type RichInlineItem = { type: 'ELEMENT'; element: Element } | { type: 'TEXT'; run: RichTextRun };
interface RichTextContext {
  computed: (element: Element) => CSSStyleDeclaration; skipped: (element: Element) => boolean;
  readStyle: (style: CSSStyleDeclaration) => ParsedStyle; transformText: (text: string, transform: string) => string;
  remainingDepth: number;
}

/** Only text styling can become character ranges. Atomic boxes retain their existing parser path. */
function eligible(element: Element, context: RichTextContext, depth = 1): boolean {
  if (depth >= context.remainingDepth || !INLINE_STYLES.has(element.localName) || context.skipped(element)) return false;
  const style = context.computed(element);
  if (style.display !== 'inline' || ['absolute', 'fixed'].includes(style.position) || style.transform !== 'none' ||
    style.filter !== 'none' || style.mixBlendMode !== 'normal' || number(style.opacity, 1) !== 1 || number(style.fontSize) <= 0 ||
    !['baseline', '0px'].includes(style.verticalAlign) || hasInlineBoxStyle(element, style) ||
    Object.values(readInsets(style, 'margin')).some(value => value !== 0) ||
    (style.position === 'relative' && [style.top, style.right, style.bottom, style.left].some(value => value !== 'auto' && number(value) !== 0))) return false;
  return [...element.children].every(child => child.localName === 'br' || eligible(child, context, depth + 1));
}

/** Child-node traversal preserves style ownership and meaningful whitespace across inline boundaries. */
export function readRichInline(element: Element, context: RichTextContext): RichInlineItem[] | null {
  const rootStyle = context.computed(element);
  if (rootStyle.display.includes('flex') || rootStyle.display.includes('grid') || ['svg', 'img', 'input', 'textarea', 'select'].includes(element.localName)) return null;
  const base = textStyle(context.readStyle(rootStyle)), baseKey = JSON.stringify(base);
  const items: RichInlineItem[] = [];
  let sources: TextSource[] = [];
  const preserve = ['pre', 'pre-wrap', 'break-spaces'].includes(rootStyle.whiteSpace);
  const flush = () => {
    if (!sources.length) return;
    const segments: { text: string; style: ParsedTextStyle; key: string }[] = [];
    let text = '', pending: ParsedTextStyle | undefined;
    const append = (value: string, style: ParsedTextStyle) => {
      const key = JSON.stringify(style), previous = segments[segments.length - 1];
      if (previous?.key === key) previous.text += value;
      else segments.push({ text: value, style, key });
      text += value;
    };
    for (const source of sources) {
      const value = context.transformText(source.text, source.transform);
      if (preserve) { append(value, source.style); continue; }
      for (const character of value) {
        const newline = character === '\n' && (rootStyle.whiteSpace === 'pre-line' || source.node.nodeType === 1);
        if (newline) { pending = undefined; append('\n', source.style); }
        else if (/[\t\n\r\f ]/.test(character)) pending = source.style;
        else { if (pending && text && !text.endsWith('\n')) append(' ', pending); pending = undefined; append(character, source.style); }
      }
    }
    if (!text) { sources = []; return; }
    const points = sources.filter(source => source.node.nodeType === 3).map(source => {
      const value = source.node.textContent || '';
      const first = preserve ? 0 : value.search(/[^\t\n\r\f ]/);
      const last = preserve ? value.length : value.length - (value.match(/[\t\n\r\f ]*$/)?.[0].length || 0);
      return { source, first, last };
    }).filter(point => point.first >= 0 && point.last > point.first);
    if (!points.length) { sources = []; return; }
    const range = element.ownerDocument.createRange();
    range.setStart(points[0]!.source.node, points[0]!.first);
    range.setEnd(points[points.length - 1]!.source.node, points[points.length - 1]!.last);
    const box = range.getBoundingClientRect(), firstRect = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
    let offset = 0;
    const ranges: ParsedTextRange[] = [];
    for (const segment of segments) {
      const end = offset + segment.text.length;
      if (segment.key !== baseKey) ranges.push({ start: offset, end, style: segment.style });
      offset = end;
    }
    // A lone styled element already has a correct standalone Text/name. Merge actual adjoining text only.
    const merge = sources.some(source => source.inline) && points.length > 1;
    items.push({ type: 'TEXT', run: { text, ranges, rect: { x: box.x, y: box.y, width: box.width, height: box.height }, firstX: firstRect?.x ?? box.x, singleLine: isSingleTextLine(range), merge } });
    sources = [];
  };
  const collect = (parent: Element, inline: boolean, decoration = '') => {
    const style = context.computed(parent), parsedStyle = textStyle(context.readStyle(style));
    // CSS decorations propagate through inline descendants even though the computed property does not inherit.
    parsedStyle.textDecoration = [...new Set(`${decoration} ${parsedStyle.textDecoration}`.split(' ').filter(value => value && value !== 'none'))].join(' ') || 'none';
    for (const child of [...parent.childNodes]) {
      if (child.nodeType === 3) sources.push({ node: child as Text, text: child.textContent || '', style: parsedStyle, transform: style.textTransform, inline });
      else if (child.nodeType === 1) {
        const childElement = child as Element;
        if (childElement.localName === 'br') sources.push({ node: childElement, text: '\n', style: parsedStyle, transform: 'none', inline });
        else if (eligible(childElement, context) && context.computed(childElement).whiteSpace === rootStyle.whiteSpace) collect(childElement, true, parsedStyle.textDecoration);
        else { flush(); items.push({ type: 'ELEMENT', element: childElement }); }
      }
    }
  };
  collect(element, false); flush();
  return items.some(item => item.type === 'TEXT' && item.run.merge) ? items : null;
}

export function richTextNode(run: RichTextRun, parent: ParsedNode, style: ParsedStyle, wholeSentence: boolean): ParsedNode {
  const available = Math.max(.01, parent.size.width - parent.layout.padding.left - parent.layout.padding.right - parent.style.borderWidths.left - parent.style.borderWidths.right);
  const constrained = !run.singleLine || (wholeSentence && (parent.size.authoredWidth !== 'auto' || parent.size.maxWidth != null || (parent.size.minWidth || 0) > 0));
  const width = constrained ? wholeSentence ? available : Math.min(available, Math.max(.01, run.rect.width)) : Math.max(.01, run.rect.width);
  const rect = { ...run.rect, width };
  if (wholeSentence && constrained) rect.x = parent.rect.x + parent.layout.padding.left + parent.style.borderWidths.left;
  return {
    type: 'TEXT', tagName: '#text', name: `${parent.name} / text`, text: run.text, ranges: run.ranges, rect,
    size: { width, height: Math.max(.01, run.rect.height), widthMode: constrained ? 'FIXED' : 'HUG', heightMode: 'HUG', authoredWidth: 'auto', authoredHeight: 'auto' },
    layout: { ...parent.layout, display: 'inline', direction: 'NONE', padding: zero(), margin: zero(), absolute: false, position: 'static', grow: 0, order: 0, alignSelf: 'auto', wrap: false, zIndex: null },
    style: { ...style, background: null, backgroundImage: undefined, backgroundGradient: undefined, backgroundLayers: undefined, backgroundGridFallback: undefined, backgroundSource: undefined,
      shadow: undefined, opacity: 1, borderWidths: zero(), radii: [0, 0, 0, 0] },
    source: { selector: `${parent.source?.selector || parent.tagName} / text`, id: '', classNames: [], synthetic: true }, children: []
  };
}

/** Scoped to the reported leading SVG + continuous text sentence; boxes/badges keep their old flow. */
export function configureRichIconRow(parent: ParsedNode, run: RichTextRun, style: CSSStyleDeclaration, autoLayout: boolean): boolean {
  if (parent.children.length !== 2 || parent.children[0]?.type !== 'SVG' || parent.children[1]?.type !== 'TEXT' || parent.children[1].ranges === undefined ||
    parent.layout.direction !== 'NONE' || parent.layout.wrap || style.direction !== 'ltr' || !['start', 'left'].includes(style.textAlign) || style.transform !== 'none' ||
    parent.children.some(child => child.layout.absolute) ||
    ['top', 'bottom', 'left'].some(side => parent.children[0]!.layout.margin[side as 'top' | 'bottom' | 'left'] !== 0)) return false;
  const icon = parent.children[0], text = parent.children[1];
  const gap = Math.max(0, icon.layout.margin.right, run.firstX - icon.rect.x - icon.rect.width);
  const left = parent.layout.padding.left + parent.style.borderWidths.left;
  const top = parent.layout.padding.top + parent.style.borderWidths.top;
  const width = Math.max(.01, parent.size.width - left - parent.layout.padding.right - parent.style.borderWidths.right - icon.size.width - gap);
  parent.layout.gap = gap; parent.layout.align = 'MIN'; parent.layout.justify = 'MIN'; parent.layout.reverse = false;
  // A bounded sentence column cannot expand its parent width through Hug/Fill feedback.
  if (parent.size.widthMode === 'HUG') parent.size.widthMode = 'FIXED';
  if (autoLayout) parent.layout.direction = 'HORIZONTAL';
  if (parent.size.authoredHeight === 'auto' && autoLayout) parent.size.heightMode = 'HUG';
  icon.size.widthMode = 'FIXED'; icon.size.heightMode = 'FIXED'; icon.layout.margin = zero(); icon.layout.grow = 0; icon.layout.shrink = 0;
  icon.rect.x = parent.rect.x + left; icon.rect.y = parent.rect.y + top;
  text.size.width = width; text.size.widthMode = autoLayout ? 'FILL' : 'FIXED'; text.size.heightMode = 'HUG';
  text.rect.x = parent.rect.x + left + icon.size.width + gap; text.rect.y = parent.rect.y + top; text.rect.width = width;
  return true;
}

/** Keep the existing single-child block wrapper, letting its height follow the wrapped sentence. */
export function configureRichWrapper(parent: ParsedNode, style: CSSStyleDeclaration, autoLayout: boolean): void {
  if (!autoLayout || parent.layout.display !== 'block' || parent.layout.direction !== 'NONE' || parent.layout.absolute ||
    parent.size.authoredHeight !== 'auto' || parent.size.widthMode === 'HUG' || parent.children.length !== 1 ||
    style.direction !== 'ltr' || style.transform !== 'none') return;
  const child = parent.children[0]!;
  const richText = child.type === 'TEXT' && child.ranges !== undefined && child.size.widthMode !== 'HUG';
  const richRow = child.type === 'FRAME' && child.layout.direction === 'HORIZONTAL' && child.size.heightMode === 'HUG' &&
    child.children.length === 2 && child.children[0]?.type === 'SVG' && child.children[1]?.ranges !== undefined;
  if ((!richText && !richRow) || child.layout.absolute || Object.values(child.layout.margin).some(value => value !== 0)) return;
  parent.layout.direction = 'VERTICAL'; parent.layout.align = 'MIN'; parent.layout.justify = 'MIN';
  parent.size.heightMode = 'HUG';
  if (richText || child.size.authoredWidth === 'auto') child.size.widthMode = 'FILL';
}

/** Grid's measured row heights must not clip newly wrapped icon sentences. Ordinary Grid rows stay unchanged. */
export function configureRichGridHeights(grid: ParsedNode): void {
  const sentenceRow = (node: ParsedNode) => node.type === 'FRAME' && node.layout.direction === 'HORIZONTAL' &&
    node.size.authoredHeight === 'auto' && node.children.length === 2 && node.children[0]?.type === 'SVG' && node.children[1]?.ranges !== undefined;
  const richCard = (node: ParsedNode) => sentenceRow(node) || (node.type === 'FRAME' && node.layout.direction === 'VERTICAL' &&
    node.size.authoredHeight === 'auto' && node.children.length === 1 && sentenceRow(node.children[0]!));
  for (const row of grid.children) {
    if (!row.source?.synthetic || row.layout.direction !== 'HORIZONTAL' || !row.children.some(cell => cell.children.length) ||
      !row.children.every(cell => cell.children.length === 0 || (cell.children.length === 1 && richCard(cell.children[0]!)))) continue;
    row.size.heightMode = 'HUG';
    for (const cell of row.children) {
      if (!cell.children.length) continue;
      cell.size.heightMode = 'HUG'; cell.children[0]!.size.heightMode = 'HUG';
    }
  }
}

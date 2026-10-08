import type { ParsedNode } from './types';
import { authoredDimension, isSingleTextLine } from './sizing';
import { number, parseColor, readInsets } from './utils';

export function hasInlineBoxStyle(element: Element, style: CSSStyleDeclaration, includeDimensions = true): boolean {
  return !!parseColor(style.backgroundColor)?.a || style.backgroundImage !== 'none' || style.boxShadow !== 'none' ||
    [readInsets(style, 'padding'), readInsets(style, 'border')].some(insets => Object.values(insets).some(value => value > 0)) ||
    ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'].some(key => number(style.getPropertyValue(key)) > 0) ||
    (includeDimensions && (authoredDimension(element, 'width') !== 'auto' || authoredDimension(element, 'height') !== 'auto'));
}

/** Hidden descendants, distinct typography and box styling cannot be represented by the parent's text. */
export function needsInlineChildren(element: Element, computed: (element: Element) => CSSStyleDeclaration, skipped: (element: Element) => boolean): boolean {
  const stack = [...element.children];
  const properties = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'color', 'text-decoration-line', 'text-transform', 'white-space'];
  while (stack.length) {
    const child = stack.pop()!;
    if (child.localName === 'br') continue; // Preserve ordinary line breaks in the existing single-Text path.
    if (skipped(child)) return true;
    const style = computed(child), parentStyle = computed(child.parentElement!);
    if (['svg', 'img', 'input', 'textarea', 'select'].includes(child.localName) || hasInlineBoxStyle(child, style) ||
      Object.values(readInsets(style, 'margin')).some(value => value !== 0) || number(style.opacity, 1) !== 1 ||
      properties.some(key => style.getPropertyValue(key) !== parentStyle.getPropertyValue(key))) return true;
    stack.push(...child.children);
  }
  return false;
}

/** A single line with uniform measured gaps can use Auto Layout without implementing inline wrapping. */
export function configureInlineRow(element: Element, node: ParsedNode, style: CSSStyleDeclaration): void {
  if (node.children.length < 2 || node.grid || node.layout.direction !== 'NONE' || node.layout.wrap || style.direction !== 'ltr' ||
    !['start', 'left'].includes(style.textAlign) || style.transform !== 'none' || node.children.some(child => child.layout.absolute || ['input', 'textarea', 'select'].includes(child.tagName) ||
      (!['inline', 'inline-block', 'inline-flex'].includes(child.layout.display) && !['SVG', 'IMAGE'].includes(child.type)))) return;
  const range = element.ownerDocument.createRange(); range.selectNodeContents(element);
  if (!isSingleTextLine(range)) return;
  if ([...element.children].some(child => {
    const childStyle = element.ownerDocument.defaultView!.getComputedStyle(child);
    return childStyle.verticalAlign !== 'baseline' || childStyle.transform !== 'none';
  })) return;
  const gaps = node.children.slice(1).map((child, index) => child.rect.x - (node.children[index]!.rect.x + node.children[index]!.rect.width));
  if (gaps.some(gap => gap < -.5) || Math.max(...gaps) - Math.min(...gaps) > 1) return;
  node.layout.direction = 'HORIZONTAL'; node.layout.align = 'BASELINE'; node.layout.justify = 'MIN'; node.layout.reverse = false;
  node.layout.gap = Math.max(0, gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length);
  node.layout.padding.left = Math.max(node.layout.padding.left, node.children[0]!.rect.x - node.rect.x - node.style.borderWidths.left);
  if (node.size.authoredHeight === 'auto') node.size.heightMode = 'HUG';
  for (const child of node.children) {
    // Measured gaps include CSS margins and inter-element whitespace already.
    child.layout.margin = { top: 0, right: 0, bottom: 0, left: 0 };
    child.layout.order = 0; child.layout.grow = 0; child.layout.alignSelf = 'auto';
  }
}

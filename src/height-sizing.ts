import type { HeightIntent, ParsedNode } from './types';
import { number } from './utils';

export function heightIntent(value: string): HeightIntent {
  if (value === 'auto' || !value) return 'auto';
  if (value === 'min-content' || value === 'max-content') return value;
  if (/fit-content|stretch|content/.test(value)) return 'intrinsic';
  if (/\b(?:\d*\.?\d+)(?:s|l|d)?v(?:h|w|min|max)\b/.test(value)) return 'viewport';
  if (value.includes('%')) return 'percent';
  return 'fixed';
}

export function readHeightSource(node: ParsedNode, element: Element, style: CSSStyleDeclaration, skipped: (child: Element) => boolean): void {
  const inlineHeight = (element as HTMLElement).style?.height || '';
  // Typed OM can resolve viewport units to px. Preserve an inline relative declaration while its used size stays in rect/height.
  if (heightIntent(node.size.authoredHeight) === 'fixed' && ['viewport', 'percent'].includes(heightIntent(inlineHeight))) node.size.authoredHeight = inlineHeight;
  node.size.heightIntent = heightIntent(node.size.authoredHeight);
  node.size.heightSource = { renderedHeight: node.rect.height, computedHeight: style.height, inlineHeight,
    minHeight: style.minHeight, maxHeight: style.maxHeight, overflowX: style.overflowX, overflowY: style.overflowY,
    normalFlowChildren: [...element.childNodes].some(child => child.nodeType === 3 ? !!child.textContent?.trim() :
      child.nodeType === 1 && !skipped(child as Element) && !['absolute', 'fixed'].includes(element.ownerDocument.defaultView!.getComputedStyle(child as Element).position)) };
}

const intrinsic = (node: ParsedNode) => ['auto', 'intrinsic', 'min-content', 'max-content'].includes(node.size.heightIntent || '');
const border = (node: ParsedNode, axis: 'x' | 'y') => axis === 'x' ? node.style.borderWidths.left + node.style.borderWidths.right : node.style.borderWidths.top + node.style.borderWidths.bottom;
const flowChildren = (node: ParsedNode) => node.children.filter(child => !child.layout.absolute);
const noMargins = (node: ParsedNode) => Object.values(node.layout.margin).every(value => value === 0);
const close = (a: number, b: number) => Math.abs(a - b) <= 1;

/** Promote only flows whose existing browser boxes match native Auto Layout, without changing width or wrappers. */
export function configureContentHeight(node: ParsedNode, element: Element, style: CSSStyleDeclaration, enabled: boolean): void {
  if (node.type !== 'FRAME' || !node.size.heightSource) return;
  const source = node.size.heightSource;
  const reason = (message: string) => { source.reason = message; };
  if (!enabled) { reason('Auto Layout disabled; measured geometry retained'); return; }
  if (node.layout.absolute) { reason('Absolute/Fixed positioning retained'); return; }
  // An explicitly sized box takes priority over the parent's content sizing.
  if (['fixed', 'viewport'].includes(node.size.heightIntent || '')) { node.size.heightMode = 'FIXED'; reason('Explicit height'); return; }
  if (node.size.heightMode === 'FILL') { reason('Parent flex-grow/stretch/percentage Fill retained'); return; }
  if (!intrinsic(node)) { node.size.heightMode = 'FIXED'; reason('Percentage/relative height retained'); return; }
  const children = flowChildren(node);
  if (!children.length) { reason('No normal-flow content; measured height retained'); return; }
  if (node.layout.wrap) {
    if (style.flexDirection !== 'row' || style.flexWrap !== 'wrap' || style.direction !== 'ltr' || style.transform !== 'none' || node.size.widthMode === 'HUG' ||
      !children.every(child => noMargins(child) && child.size.widthMode === 'FIXED') || !matchesWrappedBoxes(node, children, Math.max(0, number(style.rowGap)))) {
      node.layout.direction = 'NONE'; node.size.heightMode = 'FIXED'; reason('Complex Wrap; measured geometry retained'); return;
    }
    node.layout.direction = 'HORIZONTAL'; node.layout.wrapSpacing = Math.max(0, number(style.rowGap));
    node.size.heightMode = 'HUG'; reason('Content-driven horizontal Wrap'); return;
  }
  if (node.layout.direction !== 'NONE') { node.size.heightMode = 'HUG'; reason('Intrinsic Auto Layout content'); return; }
  // Inline/form/table boxes and anonymous wrappers keep their existing layout path.
  const identifiableBox = !!element.id || !!element.classList.length || element.hasAttribute('style') || (element.localName === 'body' && noMargins(node));
  if (style.display !== 'block' || node.size.widthMode === 'HUG' || !identifiableBox || style.transform !== 'none' ||
    !children.every(child => noMargins(child) && ['block', 'flex', 'grid'].includes(child.layout.display)) ||
    !matchesVerticalBoxes(node, children)) { reason('Flow cannot safely use vertical Auto Layout'); return; }
  node.layout.direction = 'VERTICAL'; node.layout.align = 'MIN'; node.layout.justify = 'MIN'; node.layout.gap = 0;
  node.size.heightMode = 'HUG'; reason('Measured vertical normal flow');
}

function matchesVerticalBoxes(parent: ParsedNode, children: ParsedNode[]): boolean {
  const left = parent.rect.x + parent.layout.padding.left + parent.style.borderWidths.left;
  let top = parent.rect.y + parent.layout.padding.top + parent.style.borderWidths.top;
  for (const child of children) {
    if (!close(child.rect.x, left) || !close(child.rect.y, top)) return false;
    top += child.size.height;
  }
  return close(top + parent.layout.padding.bottom + parent.style.borderWidths.bottom, parent.rect.y + parent.rect.height);
}

function matchesWrappedBoxes(parent: ParsedNode, children: ParsedNode[], rowGap: number): boolean {
  const width = parent.size.width - parent.layout.padding.left - parent.layout.padding.right - border(parent, 'x');
  const rows: ParsedNode[][] = []; let used = 0;
  for (const child of [...children].sort((a, b) => a.layout.order - b.layout.order)) {
    if (child.size.width > width + 1) return false;
    if (!rows.length || used + parent.layout.gap + child.size.width > width + .01) { rows.push([child]); used = child.size.width; }
    else { rows[rows.length - 1]!.push(child); used += parent.layout.gap + child.size.width; }
  }
  let y = parent.rect.y + parent.layout.padding.top + parent.style.borderWidths.top;
  for (const row of rows) {
    const rowWidth = row.reduce((sum, child) => sum + child.size.width, 0) + parent.layout.gap * (row.length - 1);
    const height = Math.max(...row.map(child => child.size.height));
    let x = parent.rect.x + parent.layout.padding.left + parent.style.borderWidths.left;
    if (parent.layout.justify === 'CENTER') x += (width - rowWidth) / 2;
    if (parent.layout.justify === 'MAX') x += width - rowWidth;
    const gap = parent.layout.justify === 'SPACE_BETWEEN' && row.length > 1 ? (width - row.reduce((sum, child) => sum + child.size.width, 0)) / (row.length - 1) : parent.layout.gap;
    for (const child of row) {
      const offset = parent.layout.align === 'CENTER' ? (height - child.size.height) / 2 : parent.layout.align === 'MAX' ? height - child.size.height : 0;
      if (!close(child.rect.x, x) || !close(child.rect.y, y + offset)) return false;
      x += child.size.width + gap;
    }
    y += height + rowGap;
  }
  return close(y - rowGap + parent.layout.padding.bottom + parent.style.borderWidths.bottom, parent.rect.y + parent.rect.height);
}

/** The existing viewport-width override must not turn measured 3×2 rows into a different Wrap arrangement. */
export function preserveWrappedViewportGeometry(root: ParsedNode, fallback: (node: ParsedNode) => void): void {
  const groups = (node: ParsedNode, width: number) => {
    const available = width - node.layout.padding.left - node.layout.padding.right - border(node, 'x');
    const rows: string[][] = []; let used = 0;
    for (const child of [...flowChildren(node)].sort((a, b) => a.layout.order - b.layout.order)) {
      if (!rows.length || used + node.layout.gap + child.size.width > available + .01) { rows.push([child.name]); used = child.size.width; }
      else { rows[rows.length - 1]!.push(child.name); used += node.layout.gap + child.size.width; }
    }
    return JSON.stringify(rows);
  };
  const visit = (node: ParsedNode, width: number) => {
    if (node.layout.wrapSpacing !== undefined && !close(width, node.rect.width) &&
      (node.layout.justify !== 'MIN' || groups(node, width) !== groups(node, node.rect.width))) {
      delete node.layout.wrapSpacing; node.layout.direction = 'NONE'; node.size.heightMode = 'FIXED';
      if (node.size.heightSource) node.size.heightSource.reason = 'Viewport width changes Wrap rows; measured geometry retained';
      fallback(node);
    }
    const inner = width - node.layout.padding.left - node.layout.padding.right - border(node, 'x');
    const flow = flowChildren(node), fills = flow.filter(child => child.size.widthMode === 'FILL');
    const remaining = inner - flow.filter(child => child.size.widthMode !== 'FILL').reduce((sum, child) => sum + child.size.width, 0) - Math.max(0, flow.length - 1) * node.layout.gap;
    for (const child of node.children) {
      const projected = !child.layout.absolute && child.size.widthMode === 'FILL' ? node.layout.direction === 'VERTICAL' ? inner :
        node.layout.direction === 'HORIZONTAL' && !node.layout.wrap ? remaining / Math.max(1, fills.length) : child.size.width : child.size.width;
      visit(child, projected);
    }
  };
  visit(root, root.size.width);
}

/** Root document extent is separate from an author's explicit height, including a fixed mobile shell. */
export function rootHeightMode(node: ParsedNode, enabled: boolean): 'FIXED' | 'HUG' {
  if (!enabled || node.layout.direction === 'NONE' || !flowChildren(node).length || !intrinsic(node)) return 'FIXED';
  return 'HUG';
}

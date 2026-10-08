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
      !children.every(child => noMargins(child) && (child.size.widthMode === 'FIXED' || (child.layout.contentComponent && child.size.widthMode === 'HUG'))) || !matchesWrappedBoxes(node, children, Math.max(0, number(style.rowGap)))) {
      node.layout.direction = 'NONE'; node.size.heightMode = 'FIXED'; reason('Complex Wrap; measured geometry retained'); return;
    }
    node.layout.direction = 'HORIZONTAL'; node.layout.wrapSpacing = Math.max(0, number(style.rowGap));
    node.size.heightMode = 'HUG'; reason('Content-driven horizontal Wrap'); return;
  }
  if (node.layout.direction !== 'NONE') { node.size.heightMode = 'HUG'; reason('Intrinsic Auto Layout content'); return; }
  // Inline/form/table boxes and anonymous wrappers keep their existing layout path.
  const identifiableBox = !!element.id || !!element.classList.length || element.hasAttribute('style') || (element.localName === 'body' && noMargins(node));
  const blockRejection = style.display !== 'block' ? `display:${style.display}` : node.size.widthMode === 'HUG' ? 'Width Hug' :
    !identifiableBox ? 'Anonymous box' : style.transform !== 'none' ? `transform:${style.transform}` :
    children.some(child => !['block', 'flex', 'grid'].includes(child.layout.display)) ? 'Inline/mixed child flow' : '';
  if (blockRejection) { reason(`Flow cannot safely use vertical Auto Layout: ${blockRejection}`); return; }
  if (children.every(noMargins) && matchesVerticalBoxes(node, children)) {
    node.layout.direction = 'VERTICAL'; node.layout.align = 'MIN'; node.layout.justify = 'MIN'; node.layout.gap = 0;
    node.size.heightMode = 'HUG'; reason('Measured vertical normal flow'); return;
  }
  const flow = measuredBlockFlow(node, element, style, children, failure => reason(`Flow cannot safely use vertical Auto Layout: ${failure}`));
  if (!flow) return;
  // Keep the CSS padding/margins and every existing child. Store only the verified Figma flow geometry.
  node.layout.direction = 'VERTICAL'; node.layout.normalFlow = flow;
  node.size.heightMode = 'HUG'; reason('Measured block margins/alignment; ancestor height propagation');
}

/** One vertical track with uniform measured gaps; complex/overlapping flow keeps its original coordinates. */
function measuredBlockFlow(parent: ParsedNode, element: Element, style: CSSStyleDeclaration, children: ParsedNode[], failed: (reason: string) => void): NonNullable<ParsedNode['layout']['normalFlow']> | null {
  const reject = (message: string) => { failed(message); return null; };
  if (parent.layout.reverse || children.some(child => child.layout.order !== 0 || Object.values(child.layout.margin).some(value => value < 0))) return reject('Reversed/order/negative-margin flow');
  for (const child of element.children) {
    const css = element.ownerDocument.defaultView!.getComputedStyle(child);
    if (css.display === 'none' || ['absolute', 'fixed'].includes(css.position)) continue;
    if (css.cssFloat !== 'none' || css.transform !== 'none' || (css.position === 'relative' &&
      [css.top, css.right, css.bottom, css.left].some(value => !['auto', '0px'].includes(value)))) return reject(`Child ${child.localName} has float/transform/relative offset`);
  }
  const padding = { ...parent.layout.padding };
  const contentLeft = parent.rect.x + padding.left + parent.style.borderWidths.left;
  const contentWidth = parent.rect.width - padding.left - padding.right - border(parent, 'x');
  const candidates = ['MIN', 'CENTER', 'MAX'] as const;
  const align = candidates.find(candidate => children.every(child =>
    (candidate === 'MIN' || child.size.widthMode === 'FIXED') && close(child.rect.x, contentLeft +
      (candidate === 'CENTER' ? (contentWidth - child.rect.width) / 2 : candidate === 'MAX' ? contentWidth - child.rect.width : 0))));
  if (!align) return reject('Child X/Width Mode does not match a common left/center/right alignment');
  // A changed font's intrinsic Text width must not move a centered block or affect the Width policy.
  const leading = children[0]!.rect.y - parent.rect.y - parent.style.borderWidths.top;
  if (leading < padding.top - 1 || leading > padding.top + children[0]!.layout.margin.top + 1) return reject(`Leading offset ${leading}px does not match padding + margin`);
  padding.top = Math.max(padding.top, leading);
  const gaps = children.slice(1).map((child, index) => child.rect.y - children[index]!.rect.y - children[index]!.rect.height);
  const gap = Math.max(0, gaps[0] || 0);
  if (gaps.some((value, index) => value < -.01 || !close(value, gap) || value > children[index]!.layout.margin.bottom + children[index + 1]!.layout.margin.top + 1)) return reject(`Overlapping/non-uniform/unexplained measured gaps: ${gaps.join(', ')}px`);
  const contents = children.reduce((sum, child) => sum + child.rect.height, 0) + gap * Math.max(0, children.length - 1) + padding.top + border(parent, 'y');
  const bounded = (height: number) => Math.max(parent.size.minHeight || 0, Math.min(parent.size.maxHeight ?? Infinity, height));
  const lastMargin = children[children.length - 1]!.layout.margin.bottom;
  const bottoms = [...new Set([padding.bottom, padding.bottom + lastMargin])].filter(bottom => close(bounded(contents + bottom), parent.rect.height));
  // A binding min/max height can hide whether the last margin collapses. Do not guess the growth behavior.
  if (bottoms.length !== 1) return reject(`Trailing margin/bounded height is ambiguous: ${bottoms.length} matching paddings`);
  padding.bottom = bottoms[0]!;
  if (style.boxSizing !== 'border-box' && (parent.size.minHeight || parent.size.maxHeight != null) &&
    padding.top + padding.bottom + border(parent, 'y') > 0) return reject('Content-box min/max height with padding/border');
  return { gap, padding, align };
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
export function preserveWrappedViewportGeometry(root: ParsedNode, fallback: (node: ParsedNode) => void, flowFallback: (node: ParsedNode) => void = () => {}, scrollbarGutter: number = 0): void {
  // A browser's reserved scrollbar reduces its content width; the imported viewport has no scrollbar.
  // Retain only already-verified centered block flows whose fixed-width contents still fit.
  const removesScrollbar = scrollbarGutter > 0 && root.size.authoredWidth === 'auto' &&
    close(root.rect.x, 0) && close(root.size.width - root.rect.width, scrollbarGutter);
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
    if (node.layout.normalFlow && node.layout.normalFlow.align !== 'MIN' && !close(width, node.rect.width)) {
      const available = width - node.layout.normalFlow.padding.left - node.layout.normalFlow.padding.right - border(node, 'x');
      const keepsCenteredFlow = removesScrollbar && node.layout.normalFlow.align === 'CENTER' &&
        node.size.widthMode === 'FILL' && node.size.authoredWidth === 'auto' && close(width - node.rect.width, scrollbarGutter) &&
        flowChildren(node).every(child => child.size.widthMode === 'FIXED' && child.size.width <= available + 1);
      if (keepsCenteredFlow) {
        if (node.size.heightSource) node.size.heightSource.reason = `${node.size.heightSource.reason || 'Measured centered block flow'}; viewport scrollbar gutter ${scrollbarGutter}px removed (${node.rect.width} → ${width}px); centered flow retained`;
      } else {
        delete node.layout.normalFlow; node.layout.direction = 'NONE'; node.size.heightMode = 'FIXED';
        if (node.size.heightSource) node.size.heightSource.reason = `Viewport width changes block alignment; measured geometry retained (${node.rect.width} → ${width}px, scrollbar gutter ${scrollbarGutter}px)`;
        flowFallback(node);
      }
    }
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

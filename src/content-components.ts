import type { ParsedNode } from './types';
import { isSingleTextLine } from './sizing';

/** Atomic text boxes only: no new wrappers, Rich Text splitting or ancestor sizing policy. */
export function configureContentComponent(element: Element, node: ParsedNode, style: CSSStyleDeclaration, enabled: boolean): boolean {
  if (!enabled || node.type !== 'FRAME' || node.layout.direction !== 'NONE' || node.layout.normalFlow || node.layout.absolute || node.layout.wrap || node.grid ||
    !['inline', 'inline-block', 'block'].includes(style.display) || style.direction !== 'ltr' || style.transform !== 'none' || style.cssFloat !== 'none' ||
    !['static', 'relative'].includes(style.position) || (style.position === 'relative' && [style.top, style.right, style.bottom, style.left].some(value => !['auto', '0px'].includes(value))) ||
    node.size.heightMode === 'FILL' || node.size.widthMode === 'FILL' || node.size.authoredHeight !== 'auto' || !['auto', 'fit-content', 'max-content'].includes(node.size.authoredWidth) ||
    (node.size.minWidth || 0) > 0 || node.size.maxWidth != null || (node.size.minHeight || 0) > 0 || node.size.maxHeight != null ||
    !['auto', 'content'].includes(node.layout.basis) || node.layout.grow > 0 || node.children.length < 1 || node.children.length > 3) return false;
  if (style.display === 'block' && node.size.authoredWidth === 'auto') {
    const parent = element.parentElement && element.ownerDocument.defaultView!.getComputedStyle(element.parentElement);
    const alignment = style.alignSelf === 'auto' ? parent?.alignItems : style.alignSelf;
    // Flex blockification can still be intrinsic. Ordinary auto-width block flow
    // fills its container, even if its text happens to match that width today.
    if (!parent || !['flex', 'inline-flex'].includes(parent.display) ||
      (parent.flexDirection.startsWith('column') && ['stretch', 'normal'].includes(alignment || 'normal'))) return false;
  }
  const text = node.children.filter(child => child.type === 'TEXT');
  const icons = node.children.filter(child => child.type === 'SVG' || child.type === 'IMAGE');
  if (text.length !== 1 || text.length + icons.length !== node.children.length || text[0]!.ranges !== undefined ||
    !text[0]!.text?.trim() || text[0]!.text.length > 80 || /[\r\n]/.test(text[0]!.text) ||
    node.children.some(child => child.layout.absolute || Object.values(child.layout.margin).some(value => value !== 0)) ||
    text.some(child => !['auto', 'fit-content', 'max-content'].includes(child.size.authoredWidth) || (child.size.minWidth || 0) > 0 || child.size.maxWidth != null) ||
    icons.some(icon => icon.size.width > 32 || icon.size.height > 32)) return false;
  // A styled paragraph or a plain inline span is not an independent UI component.
  const padding = node.layout.padding, border = node.style.borderWidths;
  const decorated = (!!node.style.background?.a || Object.values(border).some(value => value > 0)) && Object.values(padding).some(value => value > 0);
  if (!decorated || !['start', 'left', 'center'].includes(style.textAlign) || !['visible', 'clip'].includes(style.overflowX) || !['visible', 'clip'].includes(style.overflowY)) return false;
  const range = element.ownerDocument.createRange(); range.selectNodeContents(element);
  if (!isSingleTextLine(range)) return false;
  const contentWidth = node.rect.width - padding.left - padding.right - border.left - border.right;
  const contentHeight = node.rect.height - padding.top - padding.bottom - border.top - border.bottom;
  const children = node.children;
  const gaps = children.slice(1).map((child, index) => child.rect.x - children[index]!.rect.x - children[index]!.rect.width);
  if (gaps.some(value => value < -.5) || (gaps.length > 1 && Math.max(...gaps) - Math.min(...gaps) > 1)) return false;
  const gap = Math.max(0, gaps[0] || 0);
  const contents = children.reduce((sum, child) => sum + child.rect.width, 0) + gap * Math.max(0, children.length - 1);
  // Reject block Fill, stretched flex items and content constrained by parent width.
  if (contentWidth <= 0 || contentHeight <= 0 || contentHeight > 64 || Math.abs(contents - contentWidth) > 1 ||
    children.some(child => child.size.widthMode === 'FILL') ||
    Math.abs(children[0]!.rect.x - node.rect.x - padding.left - border.left) > 1) return false;
  const lineHeight = node.style.lineHeight ?? contentHeight;
  if (Math.abs(Math.max(lineHeight, ...icons.map(icon => icon.rect.height)) - contentHeight) > 1 ||
    icons.some(icon => Math.abs(icon.rect.y - node.rect.y - padding.top - border.top - (contentHeight - icon.rect.height) / 2) > 1)) return false;
  // The single anonymous line box may be taller than its glyph Range. Preserve that
  // measured CSS line height instead of adding fake padding or keeping a fixed background.
  const label = text[0]!;
  if (label.rect.height > contentHeight + 1) return false;
  label.style.lineHeight ??= contentHeight;
  label.size.height = lineHeight; label.size.widthMode = 'HUG'; label.size.heightMode = 'HUG';
  label.layout.grow = 0; label.layout.alignSelf = 'auto';
  for (const icon of icons) { icon.size.widthMode = 'FIXED'; icon.size.heightMode = 'FIXED'; }
  node.layout.direction = 'HORIZONTAL'; node.layout.align = 'CENTER'; node.layout.justify = 'CENTER'; node.layout.gap = gap; node.layout.contentComponent = true;
  node.size.widthMode = 'HUG'; node.size.heightMode = 'HUG';
  if (node.size.heightSource) node.size.heightSource.reason = 'Measured single-line content component; padding and line box retained';
  return true;
}

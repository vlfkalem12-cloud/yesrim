import type { ParsedNode } from './types';

// Current Figma only exposes counter-axis alignment on the parent. Deprecated
// per-child layoutAlign CENTER/MIN/MAX values must not be used as CSS align-self.
export type SelfAlignment = 'MIN' | 'CENTER' | 'MAX';
export const alignmentIntent = (value: string): SelfAlignment | undefined => value === 'center' ? 'CENTER' : value === 'flex-start' ? 'MIN' : value === 'flex-end' ? 'MAX' : undefined;

export function selfAlignment(parsed: ParsedNode, parent: FrameNode | undefined, parentParsed: ParsedNode | undefined): SelfAlignment | undefined {
  if (!parent || !parentParsed || parent.layoutMode === 'NONE' || parsed.layout.absolute ||
    !['flex', 'inline-flex'].includes(parentParsed.layout.display)) return;
  const target = alignmentIntent(parsed.layout.alignSelf);
  if (!target || target === (parent.counterAxisAlignItems || 'MIN')) return;
  const cross = parent.layoutMode === 'VERTICAL' ? 'widthMode' : 'heightMode';
  if (parentParsed.layout.wrap || parentParsed.size[cross] === 'HUG') return;
  return target;
}

export function configureSelfAlignment(wrapper: FrameNode, parsed: ParsedNode, parent: FrameNode, alignment: SelfAlignment): void {
  const vertical = parent.layoutMode === 'VERTICAL';
  wrapper.layoutMode = parent.layoutMode;
  wrapper.primaryAxisAlignItems = 'MIN'; wrapper.counterAxisAlignItems = alignment;
  wrapper.itemSpacing = 0; wrapper.clipsContent = false; wrapper.fills = [];
  const primary = vertical ? parsed.size.heightMode : parsed.size.widthMode;
  wrapper.layoutSizingHorizontal = vertical ? 'FILL' : primary === 'FILL' ? 'FILL' : 'HUG';
  wrapper.layoutSizingVertical = !vertical ? 'FILL' : primary === 'FILL' ? 'FILL' : 'HUG';
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1;
// A narrow native-flow repair for aligned block bubbles with one existing plain
// Text child. Keep the measured outer width; only the content height propagates.
export function alignedPlainText(parsed: ParsedNode, context: boolean): boolean {
  const text = parsed.children[0];
  return context && parsed.type === 'FRAME' && parsed.tagName === 'div' && parsed.layout.display === 'block' &&
    parsed.layout.direction === 'NONE' && !parsed.layout.absolute && parsed.size.authoredHeight === 'auto' && parsed.size.heightMode === 'HUG' &&
    parsed.children.length === 1 && text?.type === 'TEXT' && text.tagName === '#text' && text.source?.synthetic === true && text.ranges === undefined && !text.layout.absolute;
}
// A centered block paragraph above a bottom-aligned control row: native flow is
// safe only when browser boxes prove margins/padding have no collapse or offsets.
export function centeredControlStack(parsed: ParsedNode, parentParsed?: ParsedNode): boolean {
  if (parentParsed?.layout.direction !== 'VERTICAL' || !['flex', 'inline-flex'].includes(parentParsed.layout.display) ||
    parsed.type !== 'FRAME' || parsed.layout.display !== 'block' || (parsed.layout.direction !== 'NONE' && !parsed.layout.normalFlow) || parsed.layout.absolute ||
    parsed.size.authoredHeight !== 'auto' || parsed.size.heightMode !== 'HUG' || parsed.children.length !== 2) return false;
  const [text, row] = parsed.children;
  if (text?.type !== 'TEXT' || text.style.textAlign !== 'center' || text.size.authoredWidth !== 'auto' || text.size.maxWidth || text.size.minWidth ||
    row?.type !== 'FRAME' || row.layout.direction !== 'HORIZONTAL' || row.layout.align !== 'MAX' || row.size.authoredWidth !== 'auto' || row.size.maxWidth || row.size.minWidth) return false;
  const padding = parsed.layout.padding, border = parsed.style.borderWidths;
  let bottom = parsed.rect.y + padding.top + border.top;
  for (const child of parsed.children) {
    if (child.layout.absolute || Object.values(child.layout.margin).some(value => value < 0)) return false;
    const m = child.layout.margin;
    if (!close(child.rect.x, parsed.rect.x + padding.left + border.left + m.left) ||
      !close(child.rect.width, parsed.rect.width - padding.left - padding.right - border.left - border.right - m.left - m.right) ||
      !close(child.rect.y, bottom + m.top)) return false;
    bottom = child.rect.y + child.rect.height + m.bottom;
  }
  return close(bottom + padding.bottom + border.bottom, parsed.rect.y + parsed.rect.height);
}

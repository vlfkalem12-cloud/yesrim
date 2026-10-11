import type { ParsedNode } from './types';

// Current Figma only exposes counter-axis alignment on the parent. Deprecated
// per-child layoutAlign CENTER/MIN/MAX values must not be used as CSS align-self.
export function selfAlignment(parsed: ParsedNode, parent: FrameNode | undefined, parentParsed: ParsedNode | undefined): 'CENTER' | undefined {
  if (!parent || !parentParsed || parent.layoutMode === 'NONE' || parsed.layout.absolute ||
    !['flex', 'inline-flex'].includes(parentParsed.layout.display) || parsed.layout.alignSelf !== 'center' ||
    parent.counterAxisAlignItems === 'CENTER') return;
  const cross = parent.layoutMode === 'VERTICAL' ? 'widthMode' : 'heightMode';
  if (parentParsed.layout.wrap || parentParsed.size[cross] === 'HUG') return;
  return 'CENTER';
}

export function configureSelfAlignment(wrapper: FrameNode, parsed: ParsedNode, parent: FrameNode, alignment: 'CENTER'): void {
  const vertical = parent.layoutMode === 'VERTICAL';
  wrapper.layoutMode = parent.layoutMode;
  wrapper.primaryAxisAlignItems = 'MIN'; wrapper.counterAxisAlignItems = alignment;
  wrapper.itemSpacing = 0; wrapper.clipsContent = false; wrapper.fills = [];
  const primary = vertical ? parsed.size.heightMode : parsed.size.widthMode;
  wrapper.layoutSizingHorizontal = vertical ? 'FILL' : primary === 'FILL' ? 'FILL' : 'HUG';
  wrapper.layoutSizingVertical = !vertical ? 'FILL' : primary === 'FILL' ? 'FILL' : 'HUG';
}

import type { ParsedNode } from './types';

/** Only anonymous wrappers with identical geometry and no styling/positioning semantics qualify. */
export function optimizeEmptyWrappers(root: ParsedNode): void {
  const stack = [root];
  while (stack.length) {
    const parent = stack.pop()!;
    parent.children = parent.children.map(node => {
      while (eligible(node)) {
        const child = node.children[0]!;
        // A plain block wrapper's measured width is not a constraint on one-line text.
        // Preserve a genuine Fill relationship when promoting its child into Auto Layout.
        if (child.type !== 'TEXT' || child.size.widthMode !== 'HUG' || node.size.widthMode === 'FILL') child.size.widthMode = node.size.widthMode;
        child.size.heightMode = node.size.heightMode;
        node = child;
      }
      return node;
    });
    stack.push(...parent.children);
  }
}
function eligible(node: ParsedNode): boolean {
  const child = node.children[0];
  if (!child || node.children.length !== 1 || node.type !== 'FRAME' || node.grid || !node.source?.styleless || node.source.id || node.source.classNames.length || node.source.synthetic) return false;
  if (node.layout.direction !== 'NONE' || node.layout.position !== 'static' || child.layout.absolute || node.style.clipsContent || node.style.opacity !== 1 || node.style.background?.a || node.style.backgroundImage || node.style.backgroundGradient || node.style.backgroundLayers?.length || node.style.shadow) return false;
  if (node.layout.grow || node.layout.order || node.layout.zIndex !== null || node.layout.basis !== 'auto') return false;
  if ((node.size.minWidth || 0) > 0 || (node.size.minHeight || 0) > 0 || node.size.maxWidth != null || node.size.maxHeight != null) return false;
  if ([node.size.authoredWidth, node.size.authoredHeight, child.size.authoredWidth, child.size.authoredHeight].some(value => value !== 'auto')) return false;
  if ([node.layout.padding, node.layout.margin, node.style.borderWidths].some(insets => Object.values(insets).some(value => value !== 0)) || node.style.radii.some(value => value !== 0)) return false;
  return Math.abs(node.rect.x - child.rect.x) < .5 && Math.abs(node.rect.y - child.rect.y) < .5 && Math.abs(node.rect.width - child.rect.width) < .5 && Math.abs(node.rect.height - child.rect.height) < .5;
}

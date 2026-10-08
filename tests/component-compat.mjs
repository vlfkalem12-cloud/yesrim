// Historical height comparisons permit only the later atomic-component policy.
// The dedicated component suite compares these fields and every unaffected ancestor to d1d9cf6.
export function restoreAtomicComponentPolicy(current, previous) {
  const copy = structuredClone(current);
  function visit(node, old) {
    const atomic = node.layout.contentComponent === true;
    const row = node.layout.wrapSpacing !== undefined && old.layout.wrapSpacing === undefined && node.children.some(child => child.layout.contentComponent);
    if (atomic || row) {
      for (const key of ['direction', 'align', 'justify', 'gap']) node.layout[key] = old.layout[key];
      delete node.layout.contentComponent;
      if (old.layout.wrapSpacing === undefined) delete node.layout.wrapSpacing;
      node.size.widthMode = old.size.widthMode;
      node.size.heightMode = old.size.heightMode;
      if (node.size.heightSource && old.size.heightSource) node.size.heightSource.reason = old.size.heightSource.reason;
      if (atomic) for (const [i, child] of node.children.entries()) {
        for (const key of ['widthMode', 'heightMode', 'height']) child.size[key] = old.children[i].size[key];
        child.layout.grow = old.children[i].layout.grow; child.layout.alignSelf = old.children[i].layout.alignSelf;
        child.style.lineHeight = old.children[i].style.lineHeight;
      }
    }
    node.children.forEach((child, i) => visit(child, old.children[i]));
  }
  visit(copy.root, previous.root);
  return copy;
}

export function restoreAtomicWidthModes(current, previous) {
  function visit(node, old) {
    // Only the newly editable atom and its Text change their old Fixed width mode.
    // Width values, all paint/text/name data, and all ancestors remain compared.
    if (node.layout === 'HORIZONTAL' && node.horizontal === 'HUG' && old.horizontal === 'FIXED' && old.layout === 'NONE') {
      node.horizontal = old.horizontal;
      for (const [i, child] of node.children.entries()) child.horizontal = old.children[i].horizontal;
    }
    node.children.forEach((child, i) => visit(child, old.children[i]));
    // The gutter snapshot originally excluded layout direction. Carry it only
    // to identify the atomic width transition, retaining that comparison scope.
    node.layout = old.layout;
  }
  visit(current, previous); return current;
}

export function restoreAtomicTextResize(current, previous, doc) {
  const names = new Set();
  const collect = node => { if (node.layout.contentComponent) names.add(node.layerName || node.name); node.children.forEach(collect); };
  collect(doc.root);
  function visit(node, old) {
    if (names.has(node.name) && node.type === 'FRAME') for (const [i, child] of node.children.entries()) child.resize = old.children[i].resize;
    node.children.forEach((child, i) => visit(child, old.children[i]));
  }
  visit(current, previous); return current;
}

// This double enforces API preconditions; it does not simulate Figma's text metrics or layout engine.
export function createFigmaMock({ fonts = [{ family: 'Inter', style: 'Regular' }, { family: 'Inter', style: 'Bold' }, { family: 'Noto Sans KR', style: 'Regular' }, { family: 'Noto Sans KR', style: 'Bold' }], failFonts = [], failText = '', failSvg = false, failGradientPaint = false, rejectPaint = () => false, rejectStandaloneTextSizing = false, failSizingNames = [], textSizingShift, intrinsicWidthScale = 1, failFixedChildren = false, failRangeAPI = '', failWrap = false, simulateAutoHeight = false, simulateAutoWidth = false, simulateHugWidth = false, resizeResetsHug = false, simulateSizingCoupling = false, simulateAutoPosition = false, rejectSizingAxis = () => false, rejectLegacySizing = () => false, afterResizeWithoutConstraints = () => {}, maxPluginDataBytes = Infinity } = {}) {
  const loaded = new Set();
  const fontLoads = [];
  const images = [];
  const svgImports = [];
  const page = { type: 'PAGE', children: [], selection: [], appendChild(node) { append(this, node); } };
  let nextId = 1;
  function append(parent, node) {
    if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
    node.parent = parent; parent.children.push(node);
  }
  function make(type) {
    const data = new Map();
    let horizontal = 'FIXED', vertical = 'FIXED', characters = '', fontName, textAutoResize = 'NONE', fills = [], fixedChildren = 0, name = '', originalName = '', wrap = 'NO_WRAP', measuredHeight = 100;
    let primarySizing = 'FIXED', counterSizing = 'FIXED', grow = 0, align = 'INHERIT';
    const node = {
      id: String(nextId++), type, name: '', parent: undefined, children: [], removed: false, width: 100, height: 100, x: 0, y: 0,
      layoutMode: 'NONE', layoutPositioning: 'AUTO', fills: [], strokes: [], opacity: 1, textAutoResize: 'NONE',
      appendChild(child) { append(this, child); },
      insertChild(index, child) { append(this, child); this.children = this.children.filter(node => node !== child); this.children.splice(index, 0, child); },
      resize(width, height) { if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Invalid resize'); this.width = width; this.height = height; if (resizeResetsHug) { vertical = 'FIXED'; if (simulateSizingCoupling) primarySizing = counterSizing = 'FIXED'; } },
      resizeWithoutConstraints(width, height) { this.resize(width, height); afterResizeWithoutConstraints(this); },
      remove() { this.removed = true; for (const child of [...this.children]) child.remove(); if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      setPluginData(key, value) { if (new TextEncoder().encode(key + value).length > maxPluginDataBytes) throw new Error('Plugin data exceeds entry limit'); data.set(key, value); }, getPluginData(key) { return data.get(key) || ''; }
    };
    function sizing(value) {
      if (failSizingNames.includes(node.name)) throw new Error('Simulated layout sizing failure');
      const autoParent = node.parent?.layoutMode && node.parent.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE';
      // Compatibility case: a runtime rejects layoutSizing on text outside Auto Layout.
      if (rejectStandaloneTextSizing && type === 'TEXT' && !autoParent) throw new Error('Standalone text layout sizing unavailable');
      if (type !== 'TEXT' && node.layoutMode === 'NONE' && !autoParent) throw new Error('Sizing requires auto-layout frame or child');
      if (value === 'FILL' && !autoParent) throw new Error('Fill requires auto-layout parent');
      if (value === 'HUG' && type !== 'TEXT' && node.layoutMode === 'NONE') throw new Error('Hug requires text or auto-layout');
    }
    function getSizing(isHorizontal) {
      if (!simulateSizingCoupling || type !== 'FRAME') return isHorizontal ? horizontal : vertical;
      const autoParent = node.parent?.layoutMode && node.parent.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE';
      const parentPrimary = isHorizontal ? node.parent?.layoutMode === 'HORIZONTAL' : node.parent?.layoutMode === 'VERTICAL';
      if (autoParent && (parentPrimary ? grow === 1 : align === 'STRETCH')) return 'FILL';
      if (node.layoutMode === 'NONE') return 'FIXED';
      const primary = isHorizontal ? node.layoutMode === 'HORIZONTAL' : node.layoutMode === 'VERTICAL';
      return (primary ? primarySizing : counterSizing) === 'AUTO' ? 'HUG' : 'FIXED';
    }
    function setSizing(value, isHorizontal) {
      const axis = isHorizontal ? 'Horizontal' : 'Vertical';
      if (rejectSizingAxis(node, axis)) throw new Error(`Simulated ${axis} sizing rejection`);
      sizing(value);
      if (isHorizontal) horizontal = value; else vertical = value;
      if (!simulateSizingCoupling || type !== 'FRAME') return;
      const autoParent = node.parent?.layoutMode && node.parent.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE';
      if (autoParent) {
        const parentPrimary = isHorizontal ? node.parent.layoutMode === 'HORIZONTAL' : node.parent.layoutMode === 'VERTICAL';
        if (parentPrimary) grow = value === 'FILL' ? 1 : 0;
        else align = value === 'FILL' ? 'STRETCH' : 'INHERIT';
      }
      const primary = isHorizontal ? node.layoutMode === 'HORIZONTAL' : node.layoutMode === 'VERTICAL';
      if (primary) primarySizing = value === 'HUG' ? 'AUTO' : 'FIXED';
      else counterSizing = value === 'HUG' ? 'AUTO' : 'FIXED';
    }
    Object.defineProperties(node, {
      layoutWrap: { get: () => wrap, set: value => {
        if (failWrap || node.layoutMode !== 'HORIZONTAL') throw new Error('Wrap API unavailable');
        wrap = value;
      } },
      // Stable identity for existing layout tests; production naming is checked through node.name.
      name: { enumerable: true, get: () => name, set: value => { name = value; if (!originalName && value) originalName = value; } },
      originalName: { get: () => originalName },
      numberOfFixedChildren: { get: () => fixedChildren, set: value => {
        if (failFixedChildren) throw new Error('Simulated fixed scrolling rejection');
        if (!Number.isInteger(value) || value < 0 || value > node.children.length) throw new Error('Invalid fixed child count');
        fixedChildren = value;
      } },
      fills: { get: () => fills, set: value => {
        if (failGradientPaint && value.some(paint => paint.type === 'GRADIENT_LINEAR')) throw new Error('Simulated Gradient Paint rejection');
        if (value.some(rejectPaint)) throw new Error('Simulated individual Paint rejection');
        fills = value;
      } },
      textAutoResize: { get: () => textAutoResize, set: value => {
        textAutoResize = value;
        // Controlled geometry changes ensure the converter applies coordinates after text sizing.
        if (type === 'TEXT' && value !== 'NONE') {
          if (textSizingShift) { node.x += textSizingShift.x; node.y += textSizingShift.y; }
          if (value === 'WIDTH_AND_HEIGHT') node.width *= intrinsicWidthScale;
        }
      } },
      layoutSizingHorizontal: { get: () => getSizing(true), set: value => setSizing(value, true) },
      layoutSizingVertical: { get: () => getSizing(false), set: value => setSizing(value, false) },
      fontName: { get: () => fontName, set: value => { if (!loaded.has(`${value.family}|${value.style}`)) throw new Error('Font not loaded'); fontName = value; } },
      characters: { get: () => characters, set: value => { if (!fontName) throw new Error('Load font first'); if (failText && value.includes(failText)) throw new Error('Simulated text failure'); characters = value; } }
    });
    if (simulateSizingCoupling) Object.defineProperties(node, {
      primaryAxisSizingMode: { enumerable: true, get: () => primarySizing, set: value => { if (rejectLegacySizing(node, 'Primary', value)) throw new Error('Simulated native primary sizing rejection'); primarySizing = value; } },
      counterAxisSizingMode: { enumerable: true, get: () => counterSizing, set: value => { if (rejectLegacySizing(node, 'Counter', value)) throw new Error('Simulated native counter sizing rejection'); counterSizing = value; } },
      layoutGrow: { enumerable: true, get: () => grow, set: value => { grow = value; } },
      layoutAlign: { enumerable: true, get: () => align, set: value => { align = value; } }
    });
    if (simulateAutoWidth) {
      let measuredWidth = 100;
      Object.defineProperty(node, 'width', { enumerable: true, get: () => {
        const parent = node.parent;
        if (simulateHugWidth && type === 'FRAME' && node.layoutMode === 'HORIZONTAL' && node.layoutSizingHorizontal === 'HUG') {
          const flow = node.children.filter(child => child.layoutPositioning !== 'ABSOLUTE');
          const stroke = node.strokesIncludedInLayout ? (node.strokeLeftWeight || 0) + (node.strokeRightWeight || 0) : 0;
          return Math.max(node.minWidth || .01, Math.min(node.maxWidth ?? Infinity, flow.reduce((sum, child) => sum + child.width, 0) + Math.max(0, flow.length - 1) * (node.itemSpacing || 0) + (node.paddingLeft || 0) + (node.paddingRight || 0) + stroke));
        }
        if (!parent?.layoutMode || parent.layoutMode === 'NONE' || node.layoutPositioning === 'ABSOLUTE' || node.layoutSizingHorizontal !== 'FILL') return measuredWidth;
        const available = parent.width - (parent.paddingLeft || 0) - (parent.paddingRight || 0) -
          (parent.strokesIncludedInLayout ? (parent.strokeLeftWeight || 0) + (parent.strokeRightWeight || 0) : 0);
        let width = available;
        if (parent.layoutMode === 'HORIZONTAL') {
          const flow = parent.children.filter(child => child.layoutPositioning !== 'ABSOLUTE');
          const fills = flow.filter(child => child.layoutSizingHorizontal === 'FILL');
          width = (available - flow.filter(child => child.layoutSizingHorizontal !== 'FILL').reduce((sum, child) => sum + child.width, 0) -
            Math.max(0, flow.length - 1) * (parent.itemSpacing || 0)) / Math.max(1, fills.length);
        }
        return Math.max(node.minWidth || .01, Math.min(node.maxWidth ?? Infinity, width));
      }, set: value => { measuredWidth = value; } });
    }
    if (simulateAutoHeight) Object.defineProperty(node, 'height', { enumerable: true, get: () => {
      // A deliberately limited box-only height model; text metrics and full Figma layout remain outside this double.
      if (node.layoutSizingVertical !== 'HUG' || type !== 'FRAME' || node.layoutMode === 'NONE') return measuredHeight;
      const children = node.children.filter(child => child.layoutPositioning !== 'ABSOLUTE');
      const padding = (node.paddingTop || 0) + (node.paddingBottom || 0);
      const stroke = node.strokesIncludedInLayout ? (node.strokeTopWeight || 0) + (node.strokeBottomWeight || 0) : 0;
      let contents = 0;
      if (node.layoutMode === 'VERTICAL') contents = children.reduce((sum, child) => sum + child.height, 0) + Math.max(0, children.length - 1) * (node.itemSpacing || 0);
      else if (wrap === 'WRAP') {
        const available = node.width - (node.paddingLeft || 0) - (node.paddingRight || 0) - (node.strokesIncludedInLayout ? (node.strokeLeftWeight || 0) + (node.strokeRightWeight || 0) : 0);
        const rows = []; let width = 0;
        for (const child of children) {
          if (!rows.length || width + (node.itemSpacing || 0) + child.width > available + .01) { rows.push(child.height); width = child.width; }
          else { rows[rows.length - 1] = Math.max(rows.at(-1), child.height); width += (node.itemSpacing || 0) + child.width; }
        }
        contents = rows.reduce((sum, height) => sum + height, 0) + Math.max(0, rows.length - 1) * (node.counterAxisSpacing || 0);
      } else contents = Math.max(0, ...children.map(child => child.height));
      return Math.max(node.minHeight || .01, Math.min(node.maxHeight ?? Infinity, contents + padding + stroke));
    }, set: value => { measuredHeight = value; } });
    if (simulateAutoPosition) {
      let measuredX = 0;
      Object.defineProperty(node, 'x', { enumerable: true, get: () => {
        const parent = node.parent;
        if (simulateHugWidth && parent?.layoutMode === 'HORIZONTAL' && node.layoutPositioning !== 'ABSOLUTE') {
          const flow = parent.children.filter(child => child.layoutPositioning !== 'ABSOLUTE');
          const left = (parent.paddingLeft || 0) + (parent.strokesIncludedInLayout ? parent.strokeLeftWeight || 0 : 0);
          const available = parent.width - left - (parent.paddingRight || 0) - (parent.strokesIncludedInLayout ? parent.strokeRightWeight || 0 : 0);
          const rows = []; let used = 0;
          for (const child of flow) {
            if (!rows.length || (parent.layoutWrap === 'WRAP' && used + (parent.itemSpacing || 0) + child.width > available + .01)) { rows.push([child]); used = child.width; }
            else { rows.at(-1).push(child); used += (parent.itemSpacing || 0) + child.width; }
          }
          const row = rows.find(row => row.includes(node)) || [], index = row.indexOf(node);
          const width = row.reduce((sum, child) => sum + child.width, 0) + Math.max(0, row.length - 1) * (parent.itemSpacing || 0);
          const offset = parent.primaryAxisAlignItems === 'CENTER' ? (available - width) / 2 : parent.primaryAxisAlignItems === 'MAX' ? available - width : 0;
          return left + offset + row.slice(0, index).reduce((sum, child) => sum + child.width, 0) + index * (parent.itemSpacing || 0);
        }
        if (!parent?.layoutMode || parent.layoutMode !== 'VERTICAL' || node.layoutPositioning === 'ABSOLUTE') return measuredX;
        const left = (parent.paddingLeft || 0) + (parent.strokesIncludedInLayout ? parent.strokeLeftWeight || 0 : 0);
        const remaining = parent.width - left - (parent.paddingRight || 0) - (parent.strokesIncludedInLayout ? parent.strokeRightWeight || 0 : 0) - node.width;
        return left + (parent.counterAxisAlignItems === 'CENTER' ? remaining / 2 : parent.counterAxisAlignItems === 'MAX' ? remaining : 0);
      }, set: value => { measuredX = value; } });
      let measuredY = 0;
      Object.defineProperty(node, 'y', { enumerable: true, get: () => {
        const parent = node.parent;
        if (!parent?.layoutMode || parent.layoutMode === 'NONE' || node.layoutPositioning === 'ABSOLUTE') return measuredY;
        const flow = parent.children.filter(child => child.layoutPositioning !== 'ABSOLUTE'), index = flow.indexOf(node);
        const top = (parent.paddingTop || 0) + (parent.strokesIncludedInLayout ? parent.strokeTopWeight || 0 : 0);
        if (parent.layoutMode === 'VERTICAL') return top + flow.slice(0, index).reduce((sum, child) => sum + child.height, 0) + index * (parent.itemSpacing || 0);
        if (parent.layoutWrap !== 'WRAP') {
          if (simulateHugWidth && parent.counterAxisAlignItems === 'CENTER') return top + (parent.height - top - (parent.paddingBottom || 0) - (parent.strokesIncludedInLayout ? parent.strokeBottomWeight || 0 : 0) - node.height) / 2;
          return top;
        }
        const available = parent.width - (parent.paddingLeft || 0) - (parent.paddingRight || 0);
        let used = 0, rowHeight = 0, rowTop = top;
        for (const child of flow) {
          if (used && used + (parent.itemSpacing || 0) + child.width > available + .01) { rowTop += rowHeight + (parent.counterAxisSpacing || 0); used = 0; rowHeight = 0; }
          if (child === node) return rowTop;
          used += (used ? parent.itemSpacing || 0 : 0) + child.width; rowHeight = Math.max(rowHeight, child.height);
        }
        return measuredY;
      }, set: value => { measuredY = value; } });
    }
    if (type === 'TEXT') {
      for (const property of ['fontName', 'fills', 'fontSize', 'letterSpacing', 'textDecoration', 'lineHeight']) {
        node[`setRange${property[0].toUpperCase()}${property.slice(1)}`] = (start, end, value) => {
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > characters.length) throw new Error('Invalid UTF-16 range');
          if (property === 'fontName' && !loaded.has(`${value.family}|${value.style}`)) throw new Error('Range font not loaded');
          if (property === failRangeAPI) throw new Error('Simulated range API failure');
          node.rangeStyles ||= [];
          node.rangeStyles.push({ start, end, property, value, loadedFonts: [...loaded] });
        };
        node[`getRange${property[0].toUpperCase()}${property.slice(1)}`] = (start, end) => {
          const values = Array.from({ length: end - start }, (_, index) => node.rangeStyles?.findLast(range => range.property === property && range.start <= start + index && range.end > start + index)?.value ?? node[property]);
          return values.every(value => JSON.stringify(value) === JSON.stringify(values[0])) ? values[0] : 'MIXED';
        };
      }
    }
    page.appendChild(node);
    return node;
  }
  const figma = {
    currentPage: page,
    viewport: { center: { x: 1000, y: 800 }, scrollAndZoomIntoView(nodes) { this.zoomed = nodes; } },
    createFrame: () => make('FRAME'), createText: () => make('TEXT'), createRectangle: () => make('RECTANGLE'),
    createNodeFromSvg(svg) { svgImports.push(svg); if (failSvg || !svg.includes('<svg')) throw new Error('Unsupported SVG'); const frame = make('FRAME'); frame.appendChild(make('VECTOR')); return frame; },
    async listAvailableFontsAsync() { return fonts.map(fontName => ({ fontName })); },
    async loadFontAsync(font) { const key = `${font.family}|${font.style}`; fontLoads.push(key); if (failFonts.includes(font.family) || !fonts.some(f => f.family === font.family && f.style === font.style)) throw new Error('Unavailable font'); loaded.add(key); },
    createImage(bytes) { if (!bytes.length) throw new Error('Invalid image'); images.push(bytes); return { hash: `hash-${images.length}` }; },
    ui: { postMessage() {}, onmessage: undefined }, showUI() {}, notify() {}
  };
  return { figma, fontLoads, images, svgImports };
}
export function flatten(root) { return [root, ...root.children.flatMap(flatten)]; }

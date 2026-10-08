// This double enforces API preconditions; it does not simulate Figma's text metrics or layout engine.
export function createFigmaMock({ fonts = [{ family: 'Inter', style: 'Regular' }, { family: 'Inter', style: 'Bold' }, { family: 'Noto Sans KR', style: 'Regular' }, { family: 'Noto Sans KR', style: 'Bold' }], failFonts = [], failText = '', failSvg = false, failGradientPaint = false, rejectPaint = () => false, rejectStandaloneTextSizing = false, failSizingNames = [], textSizingShift, intrinsicWidthScale = 1, failFixedChildren = false, failRangeAPI = '', failWrap = false, simulateAutoHeight = false, resizeResetsHug = false } = {}) {
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
    const node = {
      id: String(nextId++), type, name: '', parent: undefined, children: [], removed: false, width: 100, height: 100, x: 0, y: 0,
      layoutMode: 'NONE', layoutPositioning: 'AUTO', fills: [], strokes: [], opacity: 1, textAutoResize: 'NONE',
      appendChild(child) { append(this, child); },
      insertChild(index, child) { append(this, child); this.children = this.children.filter(node => node !== child); this.children.splice(index, 0, child); },
      resize(width, height) { if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Invalid resize'); this.width = width; this.height = height; if (resizeResetsHug) vertical = 'FIXED'; },
      resizeWithoutConstraints(width, height) { this.resize(width, height); },
      remove() { this.removed = true; for (const child of [...this.children]) child.remove(); if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      setPluginData(key, value) { data.set(key, value); }, getPluginData(key) { return data.get(key) || ''; }
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
      layoutSizingHorizontal: { get: () => horizontal, set: value => { sizing(value); horizontal = value; } },
      layoutSizingVertical: { get: () => vertical, set: value => { sizing(value); vertical = value; } },
      fontName: { get: () => fontName, set: value => { if (!loaded.has(`${value.family}|${value.style}`)) throw new Error('Font not loaded'); fontName = value; } },
      characters: { get: () => characters, set: value => { if (!fontName) throw new Error('Load font first'); if (failText && value.includes(failText)) throw new Error('Simulated text failure'); characters = value; } }
    });
    if (simulateAutoHeight) Object.defineProperty(node, 'height', { enumerable: true, get: () => {
      // A deliberately limited box-only height model; text metrics and full Figma layout remain outside this double.
      if (vertical !== 'HUG' || type !== 'FRAME' || node.layoutMode === 'NONE') return measuredHeight;
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

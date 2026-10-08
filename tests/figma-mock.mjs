// This double enforces API preconditions; it does not simulate Figma's text metrics or layout engine.
export function createFigmaMock({ fonts = [{ family: 'Inter', style: 'Regular' }, { family: 'Inter', style: 'Bold' }, { family: 'Noto Sans KR', style: 'Regular' }, { family: 'Noto Sans KR', style: 'Bold' }], failFonts = [], failText = '', failSvg = false, failGradientPaint = false, rejectPaint = () => false, rejectStandaloneTextSizing = false, failSizingNames = [], textSizingShift, intrinsicWidthScale = 1, failFixedChildren = false } = {}) {
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
    let horizontal = 'FIXED', vertical = 'FIXED', characters = '', fontName, textAutoResize = 'NONE', fills = [], fixedChildren = 0, name = '', originalName = '';
    const node = {
      id: String(nextId++), type, name: '', parent: undefined, children: [], removed: false, width: 100, height: 100, x: 0, y: 0,
      layoutMode: 'NONE', layoutPositioning: 'AUTO', fills: [], strokes: [], opacity: 1, textAutoResize: 'NONE',
      appendChild(child) { append(this, child); },
      insertChild(index, child) { append(this, child); this.children = this.children.filter(node => node !== child); this.children.splice(index, 0, child); },
      resize(width, height) { if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Invalid resize'); this.width = width; this.height = height; },
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

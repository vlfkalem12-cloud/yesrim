// This double enforces API preconditions; it does not simulate Figma's text metrics or layout engine.
export function createFigmaMock({ fonts = [{ family: 'Inter', style: 'Regular' }, { family: 'Inter', style: 'Bold' }], failFonts = [], failText = '' } = {}) {
  const loaded = new Set();
  const fontLoads = [];
  const images = [];
  const page = { type: 'PAGE', children: [], selection: [], appendChild(node) { append(this, node); } };
  let nextId = 1;
  function append(parent, node) {
    if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
    node.parent = parent; parent.children.push(node);
  }
  function make(type) {
    const data = new Map();
    let horizontal = 'FIXED', vertical = 'FIXED', characters = '', fontName;
    const node = {
      id: String(nextId++), type, name: '', parent: undefined, children: [], removed: false, width: 100, height: 100, x: 0, y: 0,
      layoutMode: 'NONE', layoutPositioning: 'AUTO', fills: [], strokes: [], opacity: 1, textAutoResize: 'NONE',
      appendChild(child) { append(this, child); },
      resize(width, height) { if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Invalid resize'); this.width = width; this.height = height; },
      remove() { this.removed = true; for (const child of [...this.children]) child.remove(); if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      setPluginData(key, value) { data.set(key, value); }, getPluginData(key) { return data.get(key) || ''; }
    };
    function sizing(value) {
      const autoParent = node.parent?.layoutMode && node.parent.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE';
      if (type !== 'TEXT' && node.layoutMode === 'NONE' && !autoParent) throw new Error('Sizing requires auto-layout frame or child');
      if (value === 'FILL' && !autoParent) throw new Error('Fill requires auto-layout parent');
      if (value === 'HUG' && type !== 'TEXT' && node.layoutMode === 'NONE') throw new Error('Hug requires text or auto-layout');
    }
    Object.defineProperties(node, {
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
    async listAvailableFontsAsync() { return fonts.map(fontName => ({ fontName })); },
    async loadFontAsync(font) { const key = `${font.family}|${font.style}`; fontLoads.push(key); if (failFonts.includes(font.family) || !fonts.some(f => f.family === font.family && f.style === font.style)) throw new Error('Unavailable font'); loaded.add(key); },
    createImage(bytes) { if (!bytes.length) throw new Error('Invalid image'); images.push(bytes); return { hash: `hash-${images.length}` }; },
    ui: { postMessage() {}, onmessage: undefined }, showUI() {}, notify() {}
  };
  return { figma, fontLoads, images };
}
export function flatten(root) { return [root, ...root.children.flatMap(flatten)]; }

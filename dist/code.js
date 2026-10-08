"use strict";
(() => {
  // src/types.ts
  var LIMITS = { fileBytes: 5 * 1024 * 1024, imageBytes: 4 * 1024 * 1024, assetBytes: 16 * 1024 * 1024, nodes: 3e3, depth: 80, loadMs: 8e3, dimension: 1e5 };
  var VIEWPORT_PRESETS = {
    "1440": { width: 1440, height: 900 },
    "1280": { width: 1280, height: 800 },
    "768": { width: 768, height: 1024 },
    "375": { width: 375, height: 812 }
  };
  var VIEWPORT = { ...VIEWPORT_PRESETS["1440"], minDimension: 1, maxDimension: 1e4 };

  // src/utils.ts
  function isViewportDimension(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= VIEWPORT.minDimension && value <= VIEWPORT.maxDimension;
  }
  function clamp(value, min = 0, max = 1e5) {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/report.ts
  function warningCategory(code) {
    if (code === "BACKGROUND_DEBUG" || code === "HEIGHT_SIZING") return "Debug";
    if (/FONT/.test(code)) return "Fonts";
    if (/GRADIENT|BACKGROUND_LAYER/.test(code)) return "Unsupported CSS";
    if (/IMAGE|ASSET|BACKGROUND/.test(code)) return "Images";
    if (/GRID/.test(code)) return "Grid Fallback";
    if (/UNSUPPORTED|TRANSFORM|FLOAT|PSEUDO|SHADOW|BORDER_COLORS/.test(code)) return "Unsupported CSS";
    if (/FAILED|LIMIT|TIMEOUT|SVG/.test(code)) return "Stability";
    return "Layout";
  }
  function enrichWarnings(warnings, root) {
    const elements = /* @__PURE__ */ new Map();
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      stack.push(...node.children);
      if (node.source && !elements.has(node.name)) elements.set(node.name, node.source.selector);
    }
    const groups = {};
    for (const warning of warnings) {
      warning.category || (warning.category = warningCategory(warning.code));
      warning.element || (warning.element = elements.get(warning.node) || warning.node);
      groups[warning.category] = (groups[warning.category] || 0) + 1;
    }
    return groups;
  }

  // src/gradients.ts
  function linearGradientPaint(gradient) {
    const transforms = {
      0: [[0, -1, 1], [1, 0, 0]],
      90: [[1, 0, 0], [0, 1, 0]],
      180: [[0, 1, 0], [-1, 0, 1]],
      270: [[-1, 0, 1], [0, -1, 1]]
    };
    const nextColors = [];
    let next;
    for (let index = gradient.stops.length - 1; index >= 0; index--) {
      if (gradient.stops[index].color.a > 0) next = gradient.stops[index].color;
      nextColors[index] = next;
    }
    const stops = [];
    let previous;
    gradient.stops.forEach((stop, index) => {
      if (stop.color.a > 0) {
        previous = stop.color;
        stops.push(stop);
        return;
      }
      const before = previous || nextColors[index] || stop.color, after = nextColors[index] || before;
      stops.push({ position: stop.position, color: { ...before, a: 0 } });
      if (before.r !== after.r || before.g !== after.g || before.b !== after.b) stops.push({ position: stop.position, color: { ...after, a: 0 } });
    });
    return { type: "GRADIENT_LINEAR", gradientTransform: transforms[gradient.angle], gradientStops: stops, opacity: 1, visible: true, blendMode: "NORMAL" };
  }

  // src/backgrounds.ts
  function backgroundLayers(style) {
    const legacy = [
      ...style.backgroundGradient ? [{ type: "GRADIENT", gradient: style.backgroundGradient }] : [],
      ...style.backgroundImage ? [{ type: "IMAGE", image: style.backgroundImage }] : []
    ];
    const indexOf = (layer) => layer.type === "GRADIENT" ? layer.gradient.layerIndex : layer.type === "IMAGE" ? layer.image.layerIndex ?? 0 : layer.layerIndex;
    const layers = style.backgroundLayers ?? legacy.sort((a, b) => indexOf(a) - indexOf(b));
    if (!style.background || layers.some((layer) => layer.type === "SOLID" && layer.base)) return layers;
    return [...layers, { type: "SOLID", color: style.background, layerIndex: Math.max(-1, ...layers.map(indexOf)) + 1, base: true }];
  }
  function thinHorizontalGridLines(layers) {
    const gradients = layers.filter((layer) => !(layer.type === "SOLID" && layer.base));
    if (gradients.length < 3) return null;
    const lines = [];
    let angle;
    for (const layer of gradients) {
      if (layer.type !== "GRADIENT") return null;
      const gradient = layer.gradient;
      if (![0, 180].includes(gradient.angle) || angle !== void 0 && angle !== gradient.angle || gradient.stops.length !== 3) return null;
      angle = gradient.angle;
      const [before, peak, after] = gradient.stops;
      if (!before || !peak || !after || before.color.a !== 0 || after.color.a !== 0 || peak.color.a <= 0 || before.position >= peak.position || peak.position >= after.position || after.position - before.position > 0.020001 || Math.abs(peak.position - before.position - (after.position - peak.position)) > 1e-6) return null;
      const position = angle === 180 ? peak.position : 1 - peak.position;
      lines.push({ position, color: peak.color, layerIndex: gradient.layerIndex });
    }
    lines.sort((a, b) => a.position - b.position);
    const color = lines[0].color, spacing = lines[1].position - lines[0].position;
    if (spacing <= 0.02 || lines.some((line, index) => ["r", "g", "b", "a"].some((channel) => Math.abs(line.color[channel] - color[channel]) > 1e-6) || index > 0 && Math.abs(line.position - lines[index - 1].position - spacing) > 1e-6)) return null;
    return lines;
  }

  // src/layer-naming.ts
  var NAME_LIMIT = 40;
  var normalize = (value) => value.replace(/\s+/g, " ").trim();
  var clip = (value, limit = NAME_LIMIT) => {
    const characters = [...normalize(value)];
    return characters.length <= limit ? characters.join("") : characters.slice(0, limit - 1).join("").trimEnd() + "\u2026";
  };
  var textLayerName = (text) => clip(text || "Text");
  function parsedLayerName(node) {
    if (node.type === "TEXT") return textLayerName(node.text || "Text");
    if (node.layerName) return node.layerName;
    if (node.source?.synthetic && node.source.selector.endsWith(" / row")) return "Grid Row";
    if (node.source?.synthetic && node.source.selector.endsWith(" / cell")) return node.children[0] ? clip(`Grid Cell / ${parsedLayerName(node.children[0])}`) : "Grid Cell";
    return node.name;
  }
  function applyLayerNames(assignments, debug) {
    for (const { node, parsed, margin } of assignments) if (!node.removed) {
      const base = margin ? clip(`${parsedLayerName(parsed)} / Margin`) : parsedLayerName(parsed);
      node.name = debug && parsed.source ? `${base} [${parsed.source.selector}${margin ? " / margin" : ""}]` : base;
    }
  }

  // src/converter.ts
  var solid = (color) => ({ type: "SOLID", color: { r: clamp(color.r, 0, 1), g: clamp(color.g, 0, 1), b: clamp(color.b, 0, 1) }, opacity: clamp(color.a, 0, 1) });
  var fontWeight = (style) => {
    const value = style.toLowerCase().replace(/[\s_-]/g, "");
    if (/thin|hairline/.test(value)) return 100;
    if (/extralight|ultralight/.test(value)) return 200;
    if (/light/.test(value)) return 300;
    if (/medium/.test(value)) return 500;
    if (/semibold|demibold/.test(value)) return 600;
    if (/extrabold|ultrabold/.test(value)) return 800;
    if (/black|heavy/.test(value)) return 900;
    return /bold/.test(value) ? 700 : 400;
  };
  var FontResolver = class {
    constructor(warn) {
      this.warn = warn;
      this.available = [];
      this.cache = /* @__PURE__ */ new Map();
      this.loaded = /* @__PURE__ */ new Map();
    }
    async initialize() {
      try {
        this.available = (await figma.listAvailableFontsAsync()).map((font) => font.fontName);
      } catch {
        this.warn("FONT_LIST", "document", "\uD3F0\uD2B8 \uBAA9\uB85D\uC744 \uC77D\uC9C0 \uBABB\uD574 \uAE30\uBCF8 \uD3F0\uD2B8\uB97C \uC9C1\uC811 \uD655\uC778\uD569\uB2C8\uB2E4.");
      }
    }
    async resolve(node, styles) {
      const requested = styles ? node.style.fontFamily.split(",").map((f) => f.trim().replace(/^['"]|['"]$/g, "")) : ["Inter"];
      const weight = styles ? node.style.fontWeight : 400;
      const italic = styles && ["italic", "oblique"].includes(node.style.fontStyle);
      const korean = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(node.text || "");
      const key = `${requested.join(",")}|${weight}|${italic}|${korean}`;
      if (!this.cache.has(key)) this.cache.set(key, this.find(requested, weight, italic, korean));
      const selected = await this.cache.get(key);
      if (selected && !requested.some((name) => name.toLowerCase() === selected.family.toLowerCase())) {
        this.warn("FONT_REPLACED", node.name, `${requested.join(", ")} ${weight}${italic ? " Italic" : ""} \u2192 ${selected.family} ${selected.style}`);
      } else if (selected && (Math.abs(fontWeight(selected.style) - weight) >= 100 || /italic|oblique/i.test(selected.style) !== italic)) {
        this.warn("FONT_STYLE_REPLACED", node.name, `\uC0AC\uC6A9 \uAC00\uB2A5\uD55C ${selected.family} ${selected.style}\uB85C \uD3F0\uD2B8 \uC2A4\uD0C0\uC77C\uC744 \uB300\uCCB4\uD588\uC2B5\uB2C8\uB2E4.`);
      }
      if (!selected && korean) this.warn("KOREAN_FONT_UNAVAILABLE", node.name, "\uD55C\uAE00 \uC9C0\uC6D0\uC744 \uD655\uC778\uD560 \uC218 \uC788\uB294 \uD3F0\uD2B8\uAC00 \uC5C6\uC5B4 Latin \uD3F0\uD2B8 \uB300\uC2E0 placeholder\uB97C \uC0DD\uC131\uD569\uB2C8\uB2E4.");
      return selected;
    }
    async load(font) {
      const key = `${font.family}|${font.style}`;
      if (!this.loaded.has(key)) this.loaded.set(key, figma.loadFontAsync(font).then(() => true, () => {
        this.warn("FONT_LOAD_FAILED", font.family, `${font.family} ${font.style} \uB85C\uB529 \uC2E4\uD328`);
        return false;
      }));
      return this.loaded.get(key);
    }
    supportsKorean(family) {
      return /pretendard|noto sans (?:kr|cjk kr)|noto serif (?:kr|cjk kr)|nanum|malgun|apple sd gothic|spoqa han|d2coding|gulim|dotum|batang|함초롬|나눔|맑은 고딕|돋움|굴림|바탕/i.test(family);
    }
    async find(requested, weight, italic, korean) {
      const fallback = korean ? ["Pretendard", "Noto Sans KR", "Noto Sans CJK KR", "Nanum Gothic", "Malgun Gothic", "Apple SD Gothic Neo"] : ["Pretendard", "Inter", "Arial", "Roboto"];
      const families = [.../* @__PURE__ */ new Set([...requested.filter((family) => !korean || this.supportsKorean(family)), ...fallback])];
      for (const family of families) {
        const candidates = this.available.filter((font) => font.family.toLowerCase() === family.toLowerCase());
        candidates.sort((a, b) => this.score(a, weight, italic) - this.score(b, weight, italic));
        if (!this.available.length) candidates.push({ family, style: weight >= 600 ? italic ? "Bold Italic" : "Bold" : italic ? "Italic" : "Regular" }, { family, style: "Regular" });
        for (const font of candidates) {
          if (await this.load(font)) return font;
        }
      }
      for (const font of this.available.filter((font2) => !korean || this.supportsKorean(font2.family)).sort((a, b) => this.score(a, weight, italic) - this.score(b, weight, italic))) {
        if (await this.load(font)) return font;
      }
      return null;
    }
    score(font, weight, italic) {
      return Math.abs(fontWeight(font.style) - weight) + (/italic|oblique/i.test(font.style) === italic ? 0 : 1e3);
    }
  };
  function validateDocument(value) {
    if (!value || typeof value !== "object") throw new Error("\uC798\uBABB\uB41C \uBCC0\uD658 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
    const doc = value;
    if (doc.version !== 1 || !doc.root || !doc.options || typeof doc.options.autoLayout !== "boolean" || typeof doc.options.styles !== "boolean" || !Array.isArray(doc.warnings) || doc.warnings.length > 1e3) throw new Error("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uBCC0\uD658 \uD615\uC2DD\uC785\uB2C8\uB2E4.");
    if (!isViewportDimension(doc.options.viewport) || !isViewportDimension(doc.options.viewportHeight)) throw new Error("Viewport \uB108\uBE44\uC640 \uB192\uC774\uB294 1~10,000px\uC758 \uC815\uC218\uB85C \uC785\uB825\uD558\uC138\uC694.");
    for (const option of [doc.options.images, doc.options.shadows, doc.options.optimizeWrappers, doc.options.debug]) if (option !== void 0 && typeof option !== "boolean") throw new Error("\uC798\uBABB\uB41C \uBCC0\uD658 \uC635\uC158\uC785\uB2C8\uB2E4.");
    for (const warning of doc.warnings) if (!warning || typeof warning.code !== "string" || typeof warning.node !== "string" || typeof warning.message !== "string") throw new Error("\uC798\uBABB\uB41C \uACBD\uACE0 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
    const finite = (value2, max = LIMITS.dimension) => typeof value2 === "number" && Number.isFinite(value2) && Math.abs(value2) <= max;
    const validateGradient = (gradient) => {
      if (!gradient || ![0, 90, 180, 270].includes(gradient.angle) || !Number.isInteger(gradient.layerIndex) || gradient.layerIndex < 0 || !Array.isArray(gradient.stops) || gradient.stops.length < 2 || gradient.stops.some((stop, index) => !stop || !finite(stop.position, 1) || stop.position < 0 || index > 0 && stop.position < gradient.stops[index - 1].position || !stop.color || ![stop.color.r, stop.color.g, stop.color.b, stop.color.a].every((value2) => finite(value2, 1) && value2 >= 0))) throw new Error("\uC798\uBABB\uB41C Gradient \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
    };
    const stack = [{ node: doc.root, depth: 0 }];
    let count = 0;
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (++count > LIMITS.nodes || depth > LIMITS.depth) throw new Error("\uBB38\uC11C\uC758 \uB178\uB4DC \uC218 \uB610\uB294 \uAE4A\uC774 \uC81C\uD55C\uC744 \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
      if (!node || !["FRAME", "TEXT", "IMAGE", "SVG"].includes(node.type) || typeof node.name !== "string" || typeof node.tagName !== "string" || !Array.isArray(node.children) || !node.size || !node.layout || !node.style || !node.rect) throw new Error("\uC798\uBABB\uB41C \uB178\uB4DC \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.layerName !== void 0 && (typeof node.layerName !== "string" || node.layerName.length > 160)) throw new Error("\uC798\uBABB\uB41C Layer Name \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.svg !== void 0 && (typeof node.svg !== "string" || node.svg.length > LIMITS.fileBytes)) throw new Error("\uC798\uBABB\uB41C SVG \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.type === "TEXT" && (typeof node.text !== "string" || node.text.length > 1e6)) throw new Error("\uC798\uBABB\uB41C \uD14D\uC2A4\uD2B8 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.ranges !== void 0 && (node.type !== "TEXT" || !Array.isArray(node.ranges) || node.ranges.some((range, index) => !range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.start >= range.end || range.end > node.text.length || index > 0 && range.start < node.ranges[index - 1].end || !range.style || typeof range.style.fontFamily !== "string" || typeof range.style.fontStyle !== "string" || typeof range.style.textDecoration !== "string" || ![range.style.fontSize, range.style.fontWeight, range.style.letterSpacing].every((value2) => finite(value2)) || range.style.fontSize <= 0 || range.style.lineHeight !== null && (!finite(range.style.lineHeight) || range.style.lineHeight < 0) || range.style.color && ![range.style.color.r, range.style.color.g, range.style.color.b, range.style.color.a].every((value2) => finite(value2, 1) && value2 >= 0)))) throw new Error("\uC798\uBABB\uB41C Rich Text Range \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (!finite(node.size.width) || !finite(node.size.height) || node.size.width < 0 || node.size.height < 0 || !["FIXED", "FILL", "HUG"].includes(node.size.widthMode) || !["FIXED", "FILL", "HUG"].includes(node.size.heightMode)) throw new Error("\uC798\uBABB\uB41C \uD06C\uAE30 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.size.heightIntent !== void 0 && !["fixed", "auto", "intrinsic", "percent", "viewport", "min-content", "max-content"].includes(node.size.heightIntent)) throw new Error("\uC798\uBABB\uB41C Height Intent \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      const heightSource = node.size.heightSource;
      if (heightSource && (!finite(heightSource.renderedHeight) || heightSource.renderedHeight < 0 || typeof heightSource.normalFlowChildren !== "boolean" || ![heightSource.computedHeight, heightSource.inlineHeight, heightSource.minHeight, heightSource.maxHeight, heightSource.overflowX, heightSource.overflowY].every((value2) => typeof value2 === "string"))) throw new Error("\uC798\uBABB\uB41C Height Source \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.layout.wrapSpacing !== void 0 && (!finite(node.layout.wrapSpacing) || node.layout.wrapSpacing < 0 || !node.layout.wrap || node.layout.direction !== "HORIZONTAL")) throw new Error("\uC798\uBABB\uB41C Wrap Sizing \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      for (const value2 of [node.size.minWidth, node.size.maxWidth, node.size.minHeight, node.size.maxHeight]) if (value2 !== void 0 && value2 !== null && (!finite(value2) || value2 < 0)) throw new Error("\uC798\uBABB\uB41C \uCD5C\uC18C/\uCD5C\uB300 \uD06C\uAE30\uC785\uB2C8\uB2E4.");
      if (node.style.shadow && (!node.style.shadow.color || ![node.style.shadow.x, node.style.shadow.y, node.style.shadow.blur, node.style.shadow.spread].every((value2) => finite(value2)))) throw new Error("\uC798\uBABB\uB41C \uADF8\uB9BC\uC790 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      const gradient = node.style.backgroundGradient;
      if (gradient) validateGradient(gradient);
      if (node.style.backgroundGridFallback !== void 0 && typeof node.style.backgroundGridFallback !== "boolean") throw new Error("\uC798\uBABB\uB41C Background Grid \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.style.backgroundSource !== void 0 && (!node.style.backgroundSource || !["background", "backgroundImage", "backgroundColor", "backgroundSize", "backgroundPosition"].every((key) => {
        const value2 = node.style.backgroundSource[key];
        return typeof value2 === "string" && value2.length <= LIMITS.fileBytes;
      }))) throw new Error("\uC798\uBABB\uB41C Background Debug \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.style.backgroundLayers !== void 0) {
        if (!Array.isArray(node.style.backgroundLayers)) throw new Error("\uC798\uBABB\uB41C Background Layer \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
        for (const layer of node.style.backgroundLayers) {
          if (!layer || !["GRADIENT", "IMAGE", "SOLID"].includes(layer.type)) throw new Error("\uC798\uBABB\uB41C Background Layer \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
          if (layer.type === "GRADIENT") validateGradient(layer.gradient);
          if (layer.type === "IMAGE" && (!layer.image || ![layer.image.key, layer.image.src, layer.image.fit].every((value2) => typeof value2 === "string"))) throw new Error("\uC798\uBABB\uB41C Background Image \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
          if (layer.type === "SOLID" && (!layer.color || ![layer.color.r, layer.color.g, layer.color.b, layer.color.a].every((value2) => finite(value2, 1) && value2 >= 0) || !Number.isInteger(layer.layerIndex) || layer.layerIndex < 0 || layer.base !== void 0 && typeof layer.base !== "boolean")) throw new Error("\uC798\uBABB\uB41C Background Color \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
        }
      }
      if (!["HORIZONTAL", "VERTICAL", "NONE"].includes(node.layout.direction) || !["MIN", "CENTER", "MAX", "SPACE_BETWEEN"].includes(node.layout.justify) || !["MIN", "CENTER", "MAX", "BASELINE"].includes(node.layout.align) || !finite(node.layout.gap) || !finite(node.layout.order)) throw new Error("\uC798\uBABB\uB41C \uB808\uC774\uC544\uC6C3 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.layout.normalFlow && (node.layout.direction !== "VERTICAL" || node.layout.wrap || !["MIN", "CENTER", "MAX"].includes(node.layout.normalFlow.align) || !finite(node.layout.normalFlow.gap) || node.layout.normalFlow.gap < 0 || !node.layout.normalFlow.padding || !["top", "right", "bottom", "left"].every((side) => finite(node.layout.normalFlow.padding[side]) && node.layout.normalFlow.padding[side] >= 0))) throw new Error("\uC798\uBABB\uB41C Normal Flow \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.layout.fixedInsets && !["top", "right", "bottom", "left"].every((side) => {
        const value2 = node.layout.fixedInsets[side];
        return value2 === null || finite(value2);
      })) throw new Error("\uC798\uBABB\uB41C Fixed Viewport \uC88C\uD45C\uC785\uB2C8\uB2E4.");
      for (const inset of [node.layout.padding, node.layout.margin, node.style.borderWidths]) if (!inset || ![inset.top, inset.right, inset.bottom, inset.left].every((v) => finite(v))) throw new Error("\uC798\uBABB\uB41C \uC5EC\uBC31 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (![node.rect.x, node.rect.y, node.rect.width, node.rect.height, node.style.opacity, node.style.fontSize, node.style.fontWeight, node.style.letterSpacing, ...node.style.radii].every((v) => finite(v))) throw new Error("\uC798\uBABB\uB41C \uC2A4\uD0C0\uC77C \uCE58\uC218\uC785\uB2C8\uB2E4.");
      for (const color of [node.style.background, node.style.color, node.style.shadow?.color, ...node.style.borderColors]) if (color && ![color.r, color.g, color.b, color.a].every((v) => finite(v, 1) && v >= 0)) throw new Error("\uC798\uBABB\uB41C \uC0C9\uC0C1\uC785\uB2C8\uB2E4.");
      if (typeof node.style.fontFamily !== "string" || node.style.lineHeight !== null && !finite(node.style.lineHeight)) throw new Error("\uC798\uBABB\uB41C \uAE00\uAF34 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.type !== "FRAME" && node.children.length) throw new Error("Frame\uC774 \uC544\uB2CC \uB178\uB4DC\uC5D0 \uC790\uC2DD\uC774 \uC788\uC2B5\uB2C8\uB2E4.");
      stack.push(...node.children.map((child) => ({ node: child, depth: depth + 1 })));
    }
    if (!doc.assets || typeof doc.assets !== "object") throw new Error("\uC774\uBBF8\uC9C0 \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
    let assetBytes = 0;
    for (const bytes of Object.values(doc.assets)) {
      if (!Array.isArray(bytes) || bytes.length > LIMITS.imageBytes || !bytes.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) throw new Error("\uC798\uBABB\uB41C \uC774\uBBF8\uC9C0 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      assetBytes += bytes.length;
      if (assetBytes > LIMITS.assetBytes) throw new Error("\uC774\uBBF8\uC9C0 \uC6A9\uB7C9 \uC81C\uD55C\uC744 \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
    }
  }
  async function convertDocument(doc, onProgress = () => {
  }, cancelled2 = () => false) {
    validateDocument(doc);
    const started = Date.now();
    const report = { total: 0, autoLayout: 0, text: 0, image: 0, frames: 0, grid: 0, absolute: 0, svg: 0, durationMs: 0, warningGroups: {}, warnings: doc.warnings.map((warning) => ({ ...warning })) };
    const seen = new Set(report.warnings.map((w) => `${w.code}|${w.node}|${w.message}`));
    const warn = (code, node, message) => {
      const key = `${code}|${node}|${message}`;
      if (!seen.has(key) && report.warnings.length < 1e3) {
        report.warnings.push({ code, node, message });
        seen.add(key);
      }
    };
    const fonts = new FontResolver(warn);
    await fonts.initialize();
    const imageHashes = /* @__PURE__ */ new Map();
    const placements = [];
    const fixedPlacements = [];
    const gridBackgrounds = [];
    const backgroundDiagnostics = [];
    const namingAssignments = [];
    const isFixed = (parsed) => parsed.layout.absolute && parsed.layout.position === "fixed";
    let root;
    function imagePaint(image, name) {
      try {
        if (!image.key || !doc.assets[image.key]) throw new Error("\uC774\uBBF8\uC9C0 \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
        if (!imageHashes.has(image.key)) imageHashes.set(image.key, figma.createImage(new Uint8Array(doc.assets[image.key])).hash);
        if (image.position && !["center", "center center", "50% 50%"].includes(image.position)) warn("BACKGROUND_POSITION", name, `background-position:${image.position}\uB97C center\uB85C \uB2E8\uC21C\uD654\uD569\uB2C8\uB2E4.`);
        if (image.repeat && image.repeat !== "no-repeat") warn("BACKGROUND_REPEAT", name, "\uBC18\uBCF5 \uBC30\uACBD\uC740 \uB2E8\uC77C Image Fill\uB85C \uB2E8\uC21C\uD654\uD569\uB2C8\uB2E4.");
        if (image.fit && !["cover", "contain", "fill"].includes(image.fit)) warn("BACKGROUND_SIZE", name, `background-size:${image.fit}\uB97C cover\uB85C \uB2E8\uC21C\uD654\uD569\uB2C8\uB2E4.`);
        return { type: "IMAGE", imageHash: imageHashes.get(image.key), scaleMode: image.fit === "contain" ? "FIT" : "FILL" };
      } catch (error) {
        warn("IMAGE_PLACEHOLDER", name, `${image.src.slice(0, 180)} \u2014 ${errorMessage(error)}`);
        return null;
      }
    }
    function applyStacking(frame, children) {
      if (!children.some((child) => child.parsed.layout.zIndex !== null && child.parsed.layout.zIndex !== void 0)) return;
      const flow = children.filter((child) => !child.parsed.layout.absolute).map((child) => child.node);
      const sorted = [...children].sort((a, b) => (a.parsed.layout.zIndex || 0) - (b.parsed.layout.zIndex || 0));
      const sameFlow = (items) => items.filter((child) => !child.parsed.layout.absolute).every((child, index) => child.node === flow[index]);
      if (frame.layoutMode === "NONE" || sameFlow(sorted)) sorted.forEach((child, index) => frame.insertChild(index, child.node));
      else if (sameFlow([...sorted].reverse())) {
        frame.itemReverseZIndex = true;
        [...sorted].reverse().forEach((child, index) => frame.insertChild(index, child.node));
      } else {
        for (const child of sorted.filter((child2) => child2.parsed.layout.absolute)) {
          const next = children.find((flowChild) => !flowChild.parsed.layout.absolute && (flowChild.parsed.layout.zIndex || 0) > (child.parsed.layout.zIndex || 0));
          const index = next ? frame.children.indexOf(next.node) : frame.children.length;
          frame.insertChild(index, child.node);
        }
        warn("Z_INDEX_FLOW", frame.name, "\uBCF5\uC7A1\uD55C flow \uC790\uC2DD\uC758 z-index\uB294 Auto Layout \uC704\uCE58\uB97C \uC720\uC9C0\uD558\uBA70 \uB2E8\uC21C\uD654\uD588\uC2B5\uB2C8\uB2E4. Absolute \uB808\uC774\uC5B4 \uC21C\uC11C\uB294 \uC801\uC6A9\uD588\uC2B5\uB2C8\uB2E4.");
      }
    }
    function applyBoxStyle(node, parsed) {
      const style = parsed.style;
      const layers = backgroundLayers(style);
      const baseLayer = layers.find((layer) => layer.type === "SOLID" && layer.base);
      const base = doc.options.styles && baseLayer?.type === "SOLID" ? [solid(baseLayer.color)] : [];
      node.fills = base;
      node.strokes = [];
      if (!doc.options.styles) return;
      const indexOf = (layer) => layer.type === "GRADIENT" ? layer.gradient.layerIndex : layer.type === "IMAGE" ? layer.image.layerIndex ?? 0 : layer.layerIndex;
      const applied = [];
      for (const layer of layers) {
        if (layer.type === "SOLID" && layer.base) continue;
        if (layer.type === "IMAGE" && doc.options.images === false) continue;
        let paint = layer.type === "GRADIENT" ? linearGradientPaint(layer.gradient) : layer.type === "IMAGE" ? imagePaint(layer.image, parsed.name) : solid(layer.color);
        if (!paint) continue;
        try {
          node.fills = [...applied, paint, ...base];
        } catch (error) {
          if (layer.type !== "GRADIENT") {
            warn("BACKGROUND_LAYER", parsed.name, `Background Layer ${indexOf(layer) + 1} \uC801\uC6A9 \uC2E4\uD328: ${errorMessage(error)}`);
            continue;
          }
          paint = solid(layer.gradient.stops[0].color);
          node.fills = [...applied, paint, ...base];
          warn("GRADIENT_FALLBACK", parsed.name, `Background Layer ${indexOf(layer) + 1}: Gradient Paint \uC801\uC6A9 \uC2E4\uD328: ${errorMessage(error)}. \uCCAB \uBC88\uC9F8 color stop\uC744 Solid Fill\uB85C \uC0AC\uC6A9\uD569\uB2C8\uB2E4.`);
        }
        applied.push(paint);
        if (layer.type === "IMAGE") node.setPluginData("html-background-image", "true");
      }
      const lines = style.backgroundGridFallback && node.type === "FRAME" && parsed.type === "FRAME" ? thinHorizontalGridLines(layers) : null;
      if (lines && node.type === "FRAME") gridBackgrounds.push({ node, parsed, lines });
      if (doc.options.debug && style.backgroundLayers?.length) backgroundDiagnostics.push({ node, parsed, layers });
      node.opacity = clamp(style.opacity, 0, 1);
      if (doc.options.shadows !== false && style.shadow) {
        const shadow = style.shadow;
        let effect = { type: shadow.inset ? "INNER_SHADOW" : "DROP_SHADOW", color: shadow.color, offset: { x: shadow.x, y: shadow.y }, radius: shadow.blur, visible: true, blendMode: "NORMAL" };
        if (shadow.spread !== 0) {
          if (node.type === "RECTANGLE" || parsed.style.clipsContent && node.fills.some((paint) => paint.visible !== false)) effect = { ...effect, spread: shadow.spread };
          else warn("SHADOW_SPREAD", parsed.name, "\uC774 Frame\uC5D0\uC11C\uB294 Figma API\uAC00 shadow spread\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC544 blur\uC640 offset\uB9CC \uBC18\uC601\uD588\uC2B5\uB2C8\uB2E4.");
        }
        node.effects = [effect];
      }
      [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] = style.radii.map((v) => clamp(v));
      const { top, right, bottom, left } = style.borderWidths;
      if ([top, right, bottom, left].some((v) => v > 0)) {
        const borderColor = style.borderColors.find((color, i) => color && [top, right, bottom, left][i] > 0);
        if (borderColor) node.strokes = [solid(borderColor)];
        node.strokeAlign = "INSIDE";
        node.strokeTopWeight = clamp(top);
        node.strokeRightWeight = clamp(right);
        node.strokeBottomWeight = clamp(bottom);
        node.strokeLeftWeight = clamp(left);
        if (new Set(style.borderColors.map((color) => JSON.stringify(color))).size > 1) warn("BORDER_COLORS", parsed.name, "\uC11C\uB85C \uB2E4\uB978 \uD14C\uB450\uB9AC \uC0C9\uC0C1\uC740 \uCCAB \uBC88\uC9F8 \uC0C9\uC0C1\uC73C\uB85C \uD1B5\uD569\uD588\uC2B5\uB2C8\uB2E4.");
      }
    }
    function createBackgroundGrid(node, parsed, lines) {
      const rectangles = [];
      const original = node.fills;
      try {
        for (const [index, line] of lines.entries()) {
          const rectangle = figma.createRectangle();
          rectangles.push(rectangle);
          rectangle.name = `Grid Line / ${Math.round(line.position * 1e4) / 100}%`;
          rectangle.fills = [solid(line.color)];
          rectangle.strokes = [];
          node.insertChild(node.itemReverseZIndex ? node.children.length : index, rectangle);
          if (node.layoutMode !== "NONE") rectangle.layoutPositioning = "ABSOLUTE";
          rectangle.resizeWithoutConstraints(node.width, 1);
          rectangle.x = 0;
          rectangle.y = Math.max(0, Math.min(node.height - 1, Math.round(node.height * line.position)));
          rectangle.constraints = { horizontal: "STRETCH", vertical: "MIN" };
          rectangle.setPluginData("html-background-grid-line", String(line.position));
        }
        node.fills = original.map((paint) => paint.type === "GRADIENT_LINEAR" ? { ...paint, visible: false } : paint);
        node.setPluginData("html-background-grid-fallback", "true");
      } catch (error) {
        for (const rectangle of rectangles) if (!rectangle.removed) rectangle.remove();
        node.fills = original;
        warn("BACKGROUND_GRID_FALLBACK", parsed.name, `Grid Line Rectangle \uC0DD\uC131 \uC2E4\uD328\uB85C \uC6D0\uBCF8 Gradient Fill\uC744 \uC720\uC9C0\uD569\uB2C8\uB2E4: ${errorMessage(error)}`);
      }
    }
    function debugBackground(node, parsed, layers) {
      const fills = node.fills;
      const color = (value) => `#${[value.r, value.g, value.b].map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}${value.a === 1 ? "" : ` alpha=${value.a}`}`;
      const details = layers.map((layer, index) => `- layer ${index + 1}: ${layer.type === "GRADIENT" ? `linear-gradient (${layer.gradient.angle}deg; ${layer.gradient.stops.map((stop) => `${Math.round(stop.position * 1e4) / 100}% alpha=${stop.color.a} ${color(stop.color)}`).join(", ")})` : layer.type === "IMAGE" ? "image" : `solid ${color(layer.color)}`}`);
      const rectangles = node.type === "FRAME" ? node.children.filter((child) => child.getPluginData("html-background-grid-line")) : [];
      const diagnostics = {
        computed: parsed.style.backgroundSource,
        backgroundLayers: layers,
        figmaFills: fills,
        renderOrder: "first paint on top; solid base last",
        gridLines: rectangles.map((rectangle) => ({ name: rectangle.name, x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height }))
      };
      node.setPluginData("html-background-debug", JSON.stringify(diagnostics));
      console.info("HTML \u2192 Figma background", parsed.source?.selector || parsed.name, diagnostics);
      warn("BACKGROUND_DEBUG", parsed.name, [
        ...parsed.style.backgroundSource ? [`computed backgroundImage: ${parsed.style.backgroundSource.backgroundImage}`, `computed background: ${parsed.style.backgroundSource.background}`] : [],
        `background layers: ${layers.length}`,
        ...details,
        `figma fills: ${fills.length}`,
        "order: CSS first layer \u2192 top Paint; solid base \u2192 bottom Paint",
        ...rectangles.length ? [`Grid Line fallback: ${rectangles.length} Rectangles; original Gradient Paints hidden; visible fills: ${fills.filter((paint) => paint.visible !== false).length}`] : []
      ].join("\n"));
    }
    function configureLayout(frame, parsed) {
      frame.layoutMode = doc.options.autoLayout ? parsed.layout.direction : "NONE";
      frame.clipsContent = parsed.style.clipsContent;
      if (frame.layoutMode === "NONE") return;
      frame.primaryAxisSizingMode = "FIXED";
      frame.counterAxisSizingMode = "FIXED";
      const flow = parsed.layout.normalFlow;
      frame.primaryAxisAlignItems = flow ? "MIN" : parsed.layout.justify;
      frame.counterAxisAlignItems = flow?.align || parsed.layout.align;
      frame.itemSpacing = clamp(flow?.gap ?? parsed.layout.gap);
      const padding = flow?.padding || parsed.layout.padding;
      frame.paddingTop = clamp(padding.top);
      frame.paddingRight = clamp(padding.right);
      frame.paddingBottom = clamp(padding.bottom);
      frame.paddingLeft = clamp(padding.left);
      frame.strokesIncludedInLayout = true;
      if (parsed.layout.wrapSpacing !== void 0) {
        try {
          frame.layoutWrap = "WRAP";
          frame.counterAxisSpacing = parsed.layout.wrapSpacing;
          frame.counterAxisAlignContent = "AUTO";
        } catch (error) {
          frame.layoutMode = "NONE";
          warn("HEIGHT_LAYOUT", parsed.name, `Wrap API\uB97C \uC801\uC6A9\uD558\uC9C0 \uBABB\uD574 \uCE21\uC815\uB41C \uC88C\uD45C\xB7\uB192\uC774\uB97C \uC720\uC9C0\uD569\uB2C8\uB2E4: ${errorMessage(error)}`);
        }
      }
    }
    function applySizing(node, parsed, parent, absolute) {
      const autoParent = !!parent && parent.layoutMode !== "NONE" && !absolute;
      const autoFrame = node.type === "FRAME" && node.layoutMode !== "NONE";
      const canHug = node.type === "TEXT" || autoFrame;
      if (node.type === "TEXT") {
        const intrinsic = parsed.size.widthMode === "HUG";
        node.textAutoResize = intrinsic ? "WIDTH_AND_HEIGHT" : parsed.ranges !== void 0 ? "HEIGHT" : !doc.options.autoLayout ? "NONE" : parsed.size.heightMode === "HUG" ? "HEIGHT" : "NONE";
      }
      const mode = (requested, horizontal) => {
        if (!doc.options.autoLayout) return "FIXED";
        const offsets = parsed.layout.offsets;
        if (isFixed(parsed) && (horizontal ? parsed.size.authoredWidth === "auto" && offsets.left !== "auto" && offsets.right !== "auto" : parsed.size.authoredHeight === "auto" && offsets.top !== "auto" && offsets.bottom !== "auto")) return "FIXED";
        if (requested === "FILL" && !autoParent) return "FIXED";
        if (requested === "HUG" && !canHug) return "FIXED";
        if (requested === "HUG" && node.type === "FRAME" && node.children.some((child) => "layoutPositioning" in child && "layoutSizingHorizontal" in child && child.layoutPositioning !== "ABSOLUTE" && (horizontal ? child.layoutSizingHorizontal : child.layoutSizingVertical) === "FILL")) {
          warn("SIZING_CYCLE", parsed.name, "Hug \uBD80\uBAA8\uC640 Fill \uC790\uC2DD\uC758 \uC21C\uD658 \uD06C\uAE30\uB97C \uD53C\uD558\uB824\uACE0 \uBD80\uBAA8\uC758 \uCE21\uC815 \uCE58\uC218\uB97C \uACE0\uC815\uD588\uC2B5\uB2C8\uB2E4.");
          return "FIXED";
        }
        return requested;
      };
      if (autoFrame || autoParent) {
        try {
          node.layoutSizingHorizontal = mode(parsed.size.widthMode, true);
          node.layoutSizingVertical = mode(parsed.size.heightMode, false);
        } catch (error) {
          warn("SIZING_API", parsed.name, `\uC77C\uBD80 Auto Layout \uD06C\uAE30 \uC124\uC815\uC744 \uC801\uC6A9\uD558\uC9C0 \uBABB\uD588\uC9C0\uB9CC \uB178\uB4DC\uC640 \uC790\uC2DD \uAD6C\uC870\uB97C \uC720\uC9C0\uD569\uB2C8\uB2E4: ${errorMessage(error)}`);
        }
      }
      for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) {
        const value = parsed.size[key];
        if (value === void 0 || value === null) continue;
        if (value === 0 && key.startsWith("min")) continue;
        if (value === 0) {
          warn("SIZE_CONSTRAINT", parsed.name, `${key}:0px\uB294 Figma API\uC5D0\uC11C \uC9C1\uC811 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC544 \uCE21\uC815 \uD06C\uAE30\uB85C \uC720\uC9C0\uD569\uB2C8\uB2E4.`);
          continue;
        }
        if (autoParent || node.type === "FRAME" && node.layoutMode !== "NONE") {
          try {
            node[key] = value;
          } catch {
            warn("SIZE_CONSTRAINT", parsed.name, `${key}:${value}px\uB294 \uCE21\uC815 \uD06C\uAE30\uB85C \uC720\uC9C0\uD569\uB2C8\uB2E4.`);
          }
        } else warn("SIZE_CONSTRAINT", parsed.name, `${key}:${value}px\uB294 \uACE0\uC815 \uCE58\uC218\uC5D0 \uBC18\uC601\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.`);
      }
      if (autoParent && parsed.layout.alignSelf !== "auto" && !["stretch", "normal"].includes(parsed.layout.alignSelf)) {
        const alignment = parsed.layout.alignSelf.includes("center") ? "CENTER" : parsed.layout.alignSelf.includes("end") ? "MAX" : "MIN";
        if (alignment !== parent.counterAxisAlignItems) warn("ALIGN_SELF", parsed.name, "\uAC1C\uBCC4 align-self \uC815\uB82C\uC740 \uBD80\uBAA8\uC758 \uC815\uB82C\uB85C \uB2E8\uC21C\uD654\uD588\uC2B5\uB2C8\uB2E4.");
      }
      if (doc.options.debug && node.type === "FRAME" && parsed.size.heightSource) {
        const details = {
          ...parsed.size.heightSource,
          authoredHeight: parsed.size.authoredHeight,
          intent: parsed.size.heightIntent,
          display: parsed.layout.display,
          flexWrap: parsed.layout.wrap,
          flexGrow: parsed.layout.grow,
          mode: autoFrame || autoParent ? node.layoutSizingVertical : "FIXED"
        };
        node.setPluginData("html-height-sizing", JSON.stringify(details));
        warn("HEIGHT_SIZING", parsed.name, `renderedHeight: ${details.renderedHeight}px
authoredHeight: ${details.authoredHeight}
display: ${details.display}
flexWrap: ${details.flexWrap}
flexGrow: ${details.flexGrow}
Figma Height Mode: ${details.mode}
reason: ${details.reason || "Existing sizing policy"}`);
      }
    }
    function place(node, parsed, parent, parentParsed) {
      if (!parent || !parentParsed) return;
      if (parent.layoutMode !== "NONE" && parsed.layout.absolute) node.layoutPositioning = "ABSOLUTE";
      if (parent.layoutMode === "NONE" || parsed.layout.absolute) {
        node.x = parsed.rect.x - parentParsed.rect.x;
        node.y = parsed.rect.y - parentParsed.rect.y;
        if (parsed.layout.absolute && parsed.layout.offsets) {
          const offsets = parsed.layout.offsets;
          if (offsets.left === "auto" && offsets.right !== "auto") node.x += parsed.rect.width - node.width;
          if (offsets.top === "auto" && offsets.bottom !== "auto") node.y += parsed.rect.height - node.height;
          if (isFixed(parentParsed)) {
            if (offsets.left === "auto" && offsets.right !== "auto") node.x += parent.width - parentParsed.rect.width;
            if (offsets.top === "auto" && offsets.bottom !== "auto") node.y += parent.height - parentParsed.rect.height;
          }
          node.constraints = { horizontal: offsets.left !== "auto" && offsets.right !== "auto" ? "STRETCH" : offsets.right !== "auto" ? "MAX" : "MIN", vertical: offsets.top !== "auto" && offsets.bottom !== "auto" ? "STRETCH" : offsets.bottom !== "auto" ? "MAX" : "MIN" };
        }
      }
    }
    function placeFixed(node, parsed, viewportFrame) {
      viewportFrame.appendChild(node);
      if (viewportFrame.layoutMode !== "NONE") node.layoutPositioning = "ABSOLUTE";
      const { viewport: width, viewportHeight: height } = doc.options;
      const length = (value, extent) => /^-?\d*\.?\d+(px|%)$/.test(value) ? parseFloat(value) * (value.endsWith("%") ? extent / 100 : 1) : null;
      const { top, right, bottom, left } = parsed.layout.fixedInsets || {
        top: length(parsed.layout.offsets.top, height),
        right: length(parsed.layout.offsets.right, width),
        bottom: length(parsed.layout.offsets.bottom, height),
        left: length(parsed.layout.offsets.left, width)
      };
      const margin = parsed.layout.margin;
      const stretchedWidth = parsed.size.authoredWidth === "auto" && left !== null && right !== null;
      const stretchedHeight = parsed.size.authoredHeight === "auto" && top !== null && bottom !== null;
      if (stretchedWidth || stretchedHeight) {
        const bounded = (value, min, max) => clamp(Math.max(min ?? 0, Math.min(max ?? LIMITS.dimension, value)), 0.01);
        const horizontalSizing = node.layoutSizingHorizontal, verticalSizing = node.layoutSizingVertical;
        node.resizeWithoutConstraints(
          stretchedWidth ? bounded(width - left - right - margin.left - margin.right, parsed.size.minWidth, parsed.size.maxWidth) : node.width,
          stretchedHeight ? bounded(height - top - bottom - margin.top - margin.bottom, parsed.size.minHeight, parsed.size.maxHeight) : node.height
        );
        if (node.type === "FRAME" && node.layoutMode !== "NONE") {
          try {
            node.layoutSizingHorizontal = horizontalSizing;
            node.layoutSizingVertical = verticalSizing;
          } catch (error) {
            warn("SIZING_API", parsed.name, `Viewport \uD06C\uAE30\uB294 \uC720\uC9C0\uD558\uC9C0\uB9CC \uC77C\uBD80 \uD06C\uAE30 \uC124\uC815\uC744 \uBCF5\uC6D0\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${errorMessage(error)}`);
          }
        }
      }
      node.x = left !== null ? left + margin.left : right !== null ? width - right - margin.right - node.width : parsed.rect.x;
      node.y = top !== null ? top + margin.top : bottom !== null ? height - bottom - margin.bottom - node.height : parsed.rect.y;
      node.constraints = { horizontal: "MIN", vertical: "MIN" };
      if (doc.options.debug) {
        node.setPluginData("html-fixed-position", JSON.stringify({ viewport: { width, height }, x: node.x, y: node.y }));
        warn("FIXED_POSITION", parsed.name, `[fixed] viewport: ${width}\xD7${height}, x: ${node.x}, y: ${node.y}`);
      }
    }
    function countNode(node) {
      report.total++;
      if (node.type === "TEXT") report.text++;
      if (node.type === "FRAME" && node.layoutMode !== "NONE") report.autoLayout++;
    }
    async function create(parsed, parent, parentParsed) {
      if (cancelled2()) throw new Error("\uBCC0\uD658\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.");
      let node;
      let marginWrapper;
      try {
        if (parsed.type === "TEXT") {
          const font = await fonts.resolve(parsed, doc.options.styles);
          if (!font) {
            node = figma.createRectangle();
            node.fills = [solid({ r: 0.95, g: 0.8, b: 0.8, a: 1 })];
            warn("FONT_UNAVAILABLE", parsed.name, "\uB85C\uB4DC\uD560 \uC218 \uC788\uB294 \uD3F0\uD2B8\uAC00 \uC5C6\uC5B4 \uD14D\uC2A4\uD2B8\uB97C placeholder\uB85C \uB300\uCCB4\uD588\uC2B5\uB2C8\uB2E4.");
          } else {
            const text = figma.createText();
            node = text;
            text.fontName = font;
            text.characters = parsed.text || "";
            text.fontSize = doc.options.styles ? parsed.style.fontSize : 16;
            text.fills = [solid(doc.options.styles && parsed.style.color ? parsed.style.color : { r: 0.1, g: 0.1, b: 0.1, a: 1 })];
            if (doc.options.styles) {
              text.opacity = clamp(parsed.style.opacity, 0, 1);
              text.lineHeight = parsed.style.lineHeight !== null ? { unit: "PIXELS", value: clamp(parsed.style.lineHeight, 0.01) } : { unit: "AUTO" };
              text.letterSpacing = { unit: "PIXELS", value: parsed.style.letterSpacing };
              text.textAlignHorizontal = parsed.style.textAlign === "center" ? "CENTER" : ["right", "end"].includes(parsed.style.textAlign) ? "RIGHT" : parsed.style.textAlign === "justify" ? "JUSTIFIED" : "LEFT";
              text.textDecoration = parsed.style.textDecoration.includes("underline") ? "UNDERLINE" : parsed.style.textDecoration.includes("line-through") ? "STRIKETHROUGH" : "NONE";
              const rangeFonts = await Promise.all((parsed.ranges || []).map((range) => fonts.resolve({ ...parsed, text: parsed.text.slice(range.start, range.end), style: { ...parsed.style, ...range.style } }, true)));
              for (const [index, range] of (parsed.ranges || []).entries()) {
                try {
                  const rangeFont = rangeFonts[index];
                  if (rangeFont) text.setRangeFontName(range.start, range.end, rangeFont);
                  text.setRangeFills(range.start, range.end, [solid(range.style.color || parsed.style.color || { r: 0.1, g: 0.1, b: 0.1, a: 1 })]);
                  text.setRangeFontSize(range.start, range.end, clamp(range.style.fontSize, 1, 1e3));
                  text.setRangeLetterSpacing(range.start, range.end, { unit: "PIXELS", value: range.style.letterSpacing });
                  text.setRangeTextDecoration(range.start, range.end, range.style.textDecoration.includes("underline") ? "UNDERLINE" : range.style.textDecoration.includes("line-through") ? "STRIKETHROUGH" : "NONE");
                  text.setRangeLineHeight(range.start, range.end, range.style.lineHeight === null ? { unit: "AUTO" } : { unit: "PIXELS", value: clamp(range.style.lineHeight, 0.01) });
                } catch (error) {
                  warn("TEXT_RANGE_STYLE", parsed.name, `Rich Text ${range.start}~${range.end} \uC2A4\uD0C0\uC77C \uC77C\uBD80\uB97C \uAE30\uBCF8\uAC12\uC73C\uB85C \uC720\uC9C0\uD569\uB2C8\uB2E4: ${errorMessage(error)}`);
                }
              }
            }
          }
        } else if (parsed.type === "SVG") {
          try {
            if (!parsed.svg) throw new Error("SVG \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
            node = figma.createNodeFromSvg(parsed.svg);
            node.setPluginData("html-type", "svg");
          } catch (error) {
            node = figma.createFrame();
            node.fills = [];
            warn("SVG_IMPORT", parsed.name, `Vector \uBCC0\uD658 \uC2E4\uD328: ${errorMessage(error)}`);
          }
          node.opacity = doc.options.styles ? parsed.style.opacity : 1;
        } else if (parsed.type === "IMAGE") {
          const image = figma.createRectangle();
          node = image;
          image.setPluginData("html-type", doc.options.images === false ? "image-disabled" : "image");
          applyBoxStyle(image, parsed);
          if (doc.options.images !== false && parsed.image) {
            const paint = imagePaint(parsed.image, parsed.name);
            if (parsed.image?.fit === "fill") warn("IMAGE_STRETCH", parsed.name, "object-fit:fill\uC740 \uBE44\uC728\uC744 \uC720\uC9C0\uD558\uB294 Image Fill\uB85C \uB2E8\uC21C\uD654\uD569\uB2C8\uB2E4.");
            image.fills = paint ? [paint] : [solid({ r: 0.89, g: 0.91, b: 0.94, a: 1 })];
          }
          report.image++;
        } else {
          const frame = figma.createFrame();
          node = frame;
          if (!parent) root = frame;
          configureLayout(frame, parsed);
          applyBoxStyle(frame, parsed);
        }
        node.name = doc.options.debug && parsed.source ? `${parsed.name} [${parsed.source.selector}]` : parsed.name;
        node.setPluginData("html-source", parsed.source?.selector || parsed.tagName);
        namingAssignments.push({ node, parsed });
        if (parsed.grid?.supported) node.setPluginData("html-grid", "true");
        if (parsed.layout.absolute) node.setPluginData("html-absolute", "true");
        if (isFixed(parsed)) node.setPluginData("html-position", "fixed");
        node.resize(clamp(parsed.size.width, 0.01), clamp(parsed.size.height, 0.01));
        if (parent && isFixed(parsed)) fixedPlacements.push({ node, parsed });
        const margin = parsed.layout.margin;
        const autoParent = !!parent && parent.layoutMode !== "NONE" && !parsed.layout.absolute;
        if (autoParent && !parentParsed?.layout.normalFlow && Object.values(margin).some((v) => v !== 0)) {
          if (Object.values(margin).some((v) => v < 0)) warn("NEGATIVE_MARGIN", parsed.name, "\uC74C\uC218 margin\uC740 0\uC73C\uB85C \uB2E8\uC21C\uD654\uD588\uC2B5\uB2C8\uB2E4.");
          const top = Math.max(0, margin.top), right = Math.max(0, margin.right), bottom = Math.max(0, margin.bottom), left = Math.max(0, margin.left);
          marginWrapper = figma.createFrame();
          marginWrapper.name = `${parsed.name} / margin${doc.options.debug && parsed.source ? ` [${parsed.source.selector} / margin]` : ""}`;
          marginWrapper.fills = [];
          marginWrapper.clipsContent = false;
          marginWrapper.layoutMode = "VERTICAL";
          marginWrapper.primaryAxisSizingMode = "FIXED";
          marginWrapper.counterAxisSizingMode = "FIXED";
          marginWrapper.paddingTop = top;
          marginWrapper.paddingRight = right;
          marginWrapper.paddingBottom = bottom;
          marginWrapper.paddingLeft = left;
          marginWrapper.resize(clamp(parsed.size.width + left + right, 0.01), clamp(parsed.size.height + top + bottom, 0.01));
          namingAssignments.push({ node: marginWrapper, parsed, margin: true });
          parent.appendChild(marginWrapper);
          marginWrapper.appendChild(node);
          marginWrapper.layoutSizingHorizontal = parsed.size.widthMode === "FILL" ? "FILL" : "FIXED";
          marginWrapper.layoutSizingVertical = parsed.size.heightMode === "FILL" ? "FILL" : "FIXED";
          countNode(marginWrapper);
        } else if (parent) parent.appendChild(node);
        if (parent && parent.layoutMode !== "NONE" && parsed.layout.absolute) node.layoutPositioning = "ABSOLUTE";
        if (node.type === "FRAME" && parsed.type === "FRAME") {
          let children = [...parsed.children];
          if (node.layoutMode !== "NONE") {
            children.sort((a, b) => a.layout.order - b.layout.order);
            if (parsed.layout.reverse) children.reverse();
          }
          const childNodes = [];
          const growers = children.filter((child) => !child.layout.absolute && child.layout.grow > 0);
          if (new Set(growers.map((child) => child.layout.grow)).size > 1) {
            warn("FLEX_GROW_RATIO", parsed.name, "\uC11C\uB85C \uB2E4\uB978 flex-grow \uBE44\uC728\uC740 \uCE21\uC815\uB41C px \uCE58\uC218\uB85C \uC720\uC9C0\uD569\uB2C8\uB2E4.");
            children = children.map((child) => child.layout.grow > 0 ? { ...child, size: { ...child.size, [parsed.layout.direction === "VERTICAL" ? "heightMode" : "widthMode"]: "FIXED" } } : child);
          }
          for (const child of children) {
            try {
              childNodes.push({ parsed: child, node: await create(child, node, parsed) });
            } catch (error) {
              if (cancelled2()) throw error;
              warn("NODE_FAILED", child.name, `\uC774 \uC694\uC18C\uB97C \uC0DD\uB7B5\uD588\uC2B5\uB2C8\uB2E4: ${errorMessage(error)}`);
            }
          }
          applyStacking(node, childNodes);
        }
        applySizing(node, parsed, marginWrapper || parent, parsed.layout.absolute);
        if (marginWrapper) {
          if (parsed.size.widthMode === "HUG" && node.layoutSizingHorizontal !== "FILL") marginWrapper.layoutSizingHorizontal = "HUG";
          if (parsed.size.heightMode === "HUG" && node.layoutSizingVertical !== "FILL") marginWrapper.layoutSizingVertical = "HUG";
        }
        if (!isFixed(parsed) && !marginWrapper && parent && parentParsed && (parent.layoutMode === "NONE" || parsed.layout.absolute)) placements.push({ node, parsed, parent, parentParsed });
        countNode(node);
        if (report.total % 25 === 0) {
          onProgress(report.total);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return marginWrapper || node;
      } catch (error) {
        marginWrapper?.remove();
        if (node && !node.removed) node.remove();
        throw error;
      }
    }
    try {
      const created = await create(doc.root);
      if (created.type !== "FRAME") throw new Error("\uB8E8\uD2B8 Frame\uC744 \uC0DD\uC131\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      if (cancelled2()) throw new Error("\uBCC0\uD658\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.");
      created.name = `Imported HTML${doc.options.debug && doc.root.source ? ` [${doc.root.source.selector}]` : ""}`;
      if (created.layoutMode !== "NONE") created.layoutSizingHorizontal = "FIXED";
      const finalRootHeightMode = created.layoutMode !== "NONE" ? created.layoutSizingVertical : "FIXED";
      created.resizeWithoutConstraints(doc.options.viewport, clamp(created.height, 0.01));
      if (created.layoutMode !== "NONE" && created.layoutSizingVertical !== finalRootHeightMode) created.layoutSizingVertical = finalRootHeightMode;
      const fixed = fixedPlacements.filter((item) => !item.node.removed).sort((a, b) => (a.parsed.layout.zIndex || 0) - (b.parsed.layout.zIndex || 0));
      for (const { node, parsed } of fixed) placeFixed(node, parsed, created);
      if (fixed.length && "numberOfFixedChildren" in created) {
        try {
          created.numberOfFixedChildren = fixed.length;
        } catch (error) {
          warn("FIXED_SCROLL", created.name, `Figma \uC2A4\uD06C\uB864 \uACE0\uC815\uC744 \uC801\uC6A9\uD558\uC9C0 \uBABB\uD588\uC9C0\uB9CC Viewport \uAE30\uC900 \uC88C\uD45C\uB294 \uC720\uC9C0\uD569\uB2C8\uB2E4: ${errorMessage(error)}`);
        }
      }
      for (const { node, parsed, parent, parentParsed } of placements.reverse()) if (!node.removed) place(node, parsed, parent, parentParsed);
      for (const { node, parsed, lines } of gridBackgrounds) if (!node.removed) createBackgroundGrid(node, parsed, lines);
      for (const { node, parsed, layers } of backgroundDiagnostics) if (!node.removed) debugBackground(node, parsed, layers);
      created.x = figma.viewport.center.x - created.width / 2;
      created.y = figma.viewport.center.y - created.height / 2;
      figma.currentPage.selection = [created];
      figma.viewport.scrollAndZoomIntoView([created]);
      const nodes = [created];
      report.total = 0;
      report.text = 0;
      report.image = 0;
      report.autoLayout = 0;
      while (nodes.length) {
        const current = nodes.pop();
        report.total++;
        if (current.type === "TEXT") report.text++;
        if (current.type === "FRAME") report.frames++;
        if (current.type === "RECTANGLE" && current.getPluginData("html-type") === "image") report.image++;
        if (current.getPluginData("html-background-image") === "true") report.image++;
        if (current.getPluginData("html-type") === "svg") report.svg++;
        if (current.getPluginData("html-grid") === "true") report.grid++;
        if (current.getPluginData("html-absolute") === "true") report.absolute++;
        if (current.type === "FRAME" && current.layoutMode !== "NONE") report.autoLayout++;
        if ("children" in current) nodes.push(...current.children);
      }
      report.warningGroups = enrichWarnings(report.warnings, doc.root);
      report.durationMs = Date.now() - started;
      applyLayerNames(namingAssignments, doc.options.debug === true);
      return { frame: created, report };
    } catch (error) {
      if (root && !root.removed) root.remove();
      throw error;
    }
  }

  // src/code.ts
  figma.showUI(__html__, { width: 440, height: 760, themeColors: true });
  var busy = false;
  var cancelled = false;
  var send = (message) => figma.ui.postMessage(message);
  figma.ui.onmessage = async (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "CANCEL") {
      cancelled = true;
      return;
    }
    if (message.type !== "CREATE_FIGMA" || typeof message.requestId !== "string") return;
    if (busy) {
      send({ type: "CONVERSION_ERROR", requestId: message.requestId, payload: { success: false, message: "\uC774\uBBF8 \uBCC0\uD658\uC774 \uC9C4\uD589 \uC911\uC785\uB2C8\uB2E4." } });
      return;
    }
    busy = true;
    cancelled = false;
    const requestId = message.requestId;
    let result;
    try {
      validateDocument(message.payload);
      const { report } = await convertDocument(message.payload, (count) => send({ type: "PROGRESS", requestId, count }), () => cancelled);
      result = { type: "CONVERSION_COMPLETE", requestId, payload: { success: true, report } };
    } catch (error) {
      result = { type: "CONVERSION_ERROR", requestId, payload: { success: false, message: errorMessage(error) } };
    } finally {
      busy = false;
    }
    send(result);
    if (result.type === "CONVERSION_COMPLETE") {
      try {
        figma.notify(`${result.payload.report.total}\uAC1C\uC758 \uD3B8\uC9D1 \uAC00\uB2A5\uD55C \uB808\uC774\uC5B4\uB97C \uC0DD\uC131\uD588\uC2B5\uB2C8\uB2E4.`);
      } catch (error) {
        console.warn("Conversion notification failed", error);
      }
    }
  };
})();

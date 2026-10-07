"use strict";
(() => {
  // src/types.ts
  var LIMITS = { fileBytes: 5 * 1024 * 1024, imageBytes: 4 * 1024 * 1024, assetBytes: 16 * 1024 * 1024, nodes: 3e3, depth: 80, loadMs: 8e3, dimension: 1e5 };
  var VIEWPORT = { width: 1440, height: 900, minDimension: 1, maxDimension: 1e4 };

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
      const key = `${requested.join(",")}|${weight}|${italic}`;
      if (!this.cache.has(key)) this.cache.set(key, this.find(requested, weight, italic));
      const selected = await this.cache.get(key);
      if (selected && !requested.some((name) => name.toLowerCase() === selected.family.toLowerCase())) {
        this.warn("FONT_REPLACED", node.name, `${requested.join(", ")} \u2192 ${selected.family} ${selected.style}`);
      } else if (selected && (Math.abs(fontWeight(selected.style) - weight) >= 100 || /italic|oblique/i.test(selected.style) !== italic)) {
        this.warn("FONT_STYLE_REPLACED", node.name, `\uC0AC\uC6A9 \uAC00\uB2A5\uD55C ${selected.family} ${selected.style}\uB85C \uD3F0\uD2B8 \uC2A4\uD0C0\uC77C\uC744 \uB300\uCCB4\uD588\uC2B5\uB2C8\uB2E4.`);
      }
      return selected;
    }
    async find(requested, weight, italic) {
      const families = [.../* @__PURE__ */ new Set([...requested, "Pretendard", "Inter", "Arial", "Roboto"])];
      for (const family of families) {
        const candidates = this.available.filter((font) => font.family.toLowerCase() === family.toLowerCase());
        candidates.sort((a, b) => this.score(a, weight, italic) - this.score(b, weight, italic));
        if (!this.available.length) candidates.push({ family, style: weight >= 600 ? italic ? "Bold Italic" : "Bold" : italic ? "Italic" : "Regular" }, { family, style: "Regular" });
        for (const font of candidates) {
          const key = `${font.family}|${font.style}`;
          if (!this.loaded.has(key)) this.loaded.set(key, figma.loadFontAsync(font).then(() => true, () => false));
          if (await this.loaded.get(key)) return font;
        }
      }
      for (const font of [...this.available].sort((a, b) => this.score(a, weight, italic) - this.score(b, weight, italic))) {
        const key = `${font.family}|${font.style}`;
        if (!this.loaded.has(key)) this.loaded.set(key, figma.loadFontAsync(font).then(() => true, () => false));
        if (await this.loaded.get(key)) return font;
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
    for (const warning of doc.warnings) if (!warning || typeof warning.code !== "string" || typeof warning.node !== "string" || typeof warning.message !== "string") throw new Error("\uC798\uBABB\uB41C \uACBD\uACE0 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
    const finite = (value2, max = LIMITS.dimension) => typeof value2 === "number" && Number.isFinite(value2) && Math.abs(value2) <= max;
    const stack = [{ node: doc.root, depth: 0 }];
    let count = 0;
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (++count > LIMITS.nodes || depth > LIMITS.depth) throw new Error("\uBB38\uC11C\uC758 \uB178\uB4DC \uC218 \uB610\uB294 \uAE4A\uC774 \uC81C\uD55C\uC744 \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
      if (!node || !["FRAME", "TEXT", "IMAGE"].includes(node.type) || typeof node.name !== "string" || typeof node.tagName !== "string" || !Array.isArray(node.children) || !node.size || !node.layout || !node.style || !node.rect) throw new Error("\uC798\uBABB\uB41C \uB178\uB4DC \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (node.type === "TEXT" && (typeof node.text !== "string" || node.text.length > 1e6)) throw new Error("\uC798\uBABB\uB41C \uD14D\uC2A4\uD2B8 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (!finite(node.size.width) || !finite(node.size.height) || node.size.width < 0 || node.size.height < 0 || !["FIXED", "FILL", "HUG"].includes(node.size.widthMode) || !["FIXED", "FILL", "HUG"].includes(node.size.heightMode)) throw new Error("\uC798\uBABB\uB41C \uD06C\uAE30 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (!["HORIZONTAL", "VERTICAL", "NONE"].includes(node.layout.direction) || !["MIN", "CENTER", "MAX", "SPACE_BETWEEN"].includes(node.layout.justify) || !["MIN", "CENTER", "MAX"].includes(node.layout.align) || !finite(node.layout.gap) || !finite(node.layout.order)) throw new Error("\uC798\uBABB\uB41C \uB808\uC774\uC544\uC6C3 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      for (const inset of [node.layout.padding, node.layout.margin, node.style.borderWidths]) if (!inset || ![inset.top, inset.right, inset.bottom, inset.left].every((v) => finite(v))) throw new Error("\uC798\uBABB\uB41C \uC5EC\uBC31 \uB370\uC774\uD130\uC785\uB2C8\uB2E4.");
      if (![node.rect.x, node.rect.y, node.rect.width, node.rect.height, node.style.opacity, node.style.fontSize, node.style.fontWeight, node.style.letterSpacing, ...node.style.radii].every((v) => finite(v))) throw new Error("\uC798\uBABB\uB41C \uC2A4\uD0C0\uC77C \uCE58\uC218\uC785\uB2C8\uB2E4.");
      for (const color of [node.style.background, node.style.color, ...node.style.borderColors]) if (color && ![color.r, color.g, color.b, color.a].every((v) => finite(v, 1) && v >= 0)) throw new Error("\uC798\uBABB\uB41C \uC0C9\uC0C1\uC785\uB2C8\uB2E4.");
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
    const report = { total: 0, autoLayout: 0, text: 0, image: 0, warnings: [...doc.warnings] };
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
    let root;
    function applyBoxStyle(node, parsed) {
      const style = parsed.style;
      node.fills = doc.options.styles && style.background ? [solid(style.background)] : [];
      node.strokes = [];
      if (!doc.options.styles) return;
      node.opacity = clamp(style.opacity, 0, 1);
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
    function configureLayout(frame, parsed) {
      frame.layoutMode = doc.options.autoLayout ? parsed.layout.direction : "NONE";
      frame.clipsContent = parsed.style.clipsContent;
      if (frame.layoutMode === "NONE") return;
      frame.primaryAxisSizingMode = "FIXED";
      frame.counterAxisSizingMode = "FIXED";
      frame.primaryAxisAlignItems = parsed.layout.justify;
      frame.counterAxisAlignItems = parsed.layout.align;
      frame.itemSpacing = clamp(parsed.layout.gap);
      frame.paddingTop = clamp(parsed.layout.padding.top);
      frame.paddingRight = clamp(parsed.layout.padding.right);
      frame.paddingBottom = clamp(parsed.layout.padding.bottom);
      frame.paddingLeft = clamp(parsed.layout.padding.left);
      frame.strokesIncludedInLayout = true;
    }
    function applySizing(node, parsed, parent, absolute) {
      const autoParent = !!parent && parent.layoutMode !== "NONE" && !absolute;
      const canHug = node.type === "TEXT" || node.type === "FRAME" && node.layoutMode !== "NONE";
      const mode = (requested, horizontal) => {
        if (!doc.options.autoLayout) return "FIXED";
        if (requested === "FILL" && !autoParent) return "FIXED";
        if (requested === "HUG" && !canHug) return "FIXED";
        if (requested === "HUG" && node.type === "FRAME" && node.children.some((child) => "layoutPositioning" in child && "layoutSizingHorizontal" in child && child.layoutPositioning !== "ABSOLUTE" && (horizontal ? child.layoutSizingHorizontal : child.layoutSizingVertical) === "FILL")) {
          warn("SIZING_CYCLE", parsed.name, "Hug \uBD80\uBAA8\uC640 Fill \uC790\uC2DD\uC758 \uC21C\uD658 \uD06C\uAE30\uB97C \uD53C\uD558\uB824\uACE0 \uBD80\uBAA8\uC758 \uCE21\uC815 \uCE58\uC218\uB97C \uACE0\uC815\uD588\uC2B5\uB2C8\uB2E4.");
          return "FIXED";
        }
        return requested;
      };
      if (canHug || autoParent) {
        node.layoutSizingHorizontal = mode(parsed.size.widthMode, true);
        node.layoutSizingVertical = mode(parsed.size.heightMode, false);
      }
      if (autoParent && parsed.layout.alignSelf !== "auto" && !["stretch", "normal"].includes(parsed.layout.alignSelf)) {
        const alignment = parsed.layout.alignSelf.includes("center") ? "CENTER" : parsed.layout.alignSelf.includes("end") ? "MAX" : "MIN";
        if (alignment !== parent.counterAxisAlignItems) warn("ALIGN_SELF", parsed.name, "\uAC1C\uBCC4 align-self \uC815\uB82C\uC740 \uBD80\uBAA8\uC758 \uC815\uB82C\uB85C \uB2E8\uC21C\uD654\uD588\uC2B5\uB2C8\uB2E4.");
      }
    }
    function place(node, parsed, parent, parentParsed) {
      if (!parent || !parentParsed) return;
      if (parent.layoutMode !== "NONE" && parsed.layout.absolute) node.layoutPositioning = "ABSOLUTE";
      if (parent.layoutMode === "NONE" || parsed.layout.absolute) {
        node.x = parsed.rect.x - parentParsed.rect.x;
        node.y = parsed.rect.y - parentParsed.rect.y;
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
            }
            text.textAutoResize = !doc.options.autoLayout ? "NONE" : parsed.size.widthMode === "HUG" && !parsed.layout.absolute ? "WIDTH_AND_HEIGHT" : parsed.size.heightMode === "HUG" ? "HEIGHT" : "NONE";
          }
        } else if (parsed.type === "IMAGE") {
          const image = figma.createRectangle();
          node = image;
          image.setPluginData("html-type", "image");
          applyBoxStyle(image, parsed);
          const key = parsed.image?.key;
          try {
            if (!key || !doc.assets[key]) throw new Error("\uC774\uBBF8\uC9C0 \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
            if (!imageHashes.has(key)) imageHashes.set(key, figma.createImage(new Uint8Array(doc.assets[key])).hash);
            const scaleMode = parsed.image?.fit === "contain" ? "FIT" : "FILL";
            if (parsed.image?.fit === "fill") warn("IMAGE_STRETCH", parsed.name, "object-fit:fill\uC740 \uBE44\uC728\uC744 \uC720\uC9C0\uD558\uB294 Image Fill\uB85C \uB2E8\uC21C\uD654\uD569\uB2C8\uB2E4.");
            image.fills = [{ type: "IMAGE", imageHash: imageHashes.get(key), scaleMode }];
          } catch (error) {
            image.fills = [solid({ r: 0.89, g: 0.91, b: 0.94, a: 1 })];
            warn("IMAGE_PLACEHOLDER", parsed.name, `Image Fill\uC744 placeholder\uB85C \uB300\uCCB4\uD588\uC2B5\uB2C8\uB2E4: ${errorMessage(error)}`);
          }
          report.image++;
        } else {
          const frame = figma.createFrame();
          node = frame;
          if (!parent) root = frame;
          applyBoxStyle(frame, parsed);
          configureLayout(frame, parsed);
        }
        node.name = parsed.name;
        node.resize(clamp(parsed.size.width, 0.01), clamp(parsed.size.height, 0.01));
        const margin = parsed.layout.margin;
        const autoParent = !!parent && parent.layoutMode !== "NONE" && !parsed.layout.absolute;
        if (autoParent && Object.values(margin).some((v) => v !== 0)) {
          if (Object.values(margin).some((v) => v < 0)) warn("NEGATIVE_MARGIN", parsed.name, "\uC74C\uC218 margin\uC740 0\uC73C\uB85C \uB2E8\uC21C\uD654\uD588\uC2B5\uB2C8\uB2E4.");
          const top = Math.max(0, margin.top), right = Math.max(0, margin.right), bottom = Math.max(0, margin.bottom), left = Math.max(0, margin.left);
          marginWrapper = figma.createFrame();
          marginWrapper.name = `${parsed.name} / margin`;
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
          parent.appendChild(marginWrapper);
          marginWrapper.appendChild(node);
          marginWrapper.layoutSizingHorizontal = parsed.size.widthMode === "FILL" ? "FILL" : "FIXED";
          marginWrapper.layoutSizingVertical = parsed.size.heightMode === "FILL" ? "FILL" : "FIXED";
          countNode(marginWrapper);
        } else if (parent) parent.appendChild(node);
        place(node, parsed, marginWrapper ? void 0 : parent, parentParsed);
        if (node.type === "FRAME") {
          let children = [...parsed.children];
          if (node.layoutMode !== "NONE") {
            children.sort((a, b) => a.layout.order - b.layout.order);
            if (parsed.layout.reverse) children.reverse();
          }
          for (const child of children) {
            try {
              await create(child, node, parsed);
            } catch (error) {
              if (cancelled2()) throw error;
              warn("NODE_FAILED", child.name, `\uC774 \uC694\uC18C\uB97C \uC0DD\uB7B5\uD588\uC2B5\uB2C8\uB2E4: ${errorMessage(error)}`);
            }
          }
        }
        applySizing(node, parsed, marginWrapper || parent, parsed.layout.absolute);
        if (marginWrapper) {
          if (parsed.size.widthMode === "HUG" && node.layoutSizingHorizontal !== "FILL") marginWrapper.layoutSizingHorizontal = "HUG";
          if (parsed.size.heightMode === "HUG" && node.layoutSizingVertical !== "FILL") marginWrapper.layoutSizingVertical = "HUG";
        }
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
      created.name = "Imported HTML";
      if (created.layoutMode !== "NONE") created.layoutSizingHorizontal = "FIXED";
      created.resize(doc.options.viewport, clamp(created.height, 0.01));
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
        if (current.type === "RECTANGLE" && current.getPluginData("html-type") === "image") report.image++;
        if (current.type === "FRAME" && current.layoutMode !== "NONE") report.autoLayout++;
        if ("children" in current) nodes.push(...current.children);
      }
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
    if (message.type !== "CREATE_FIGMA" || typeof message.requestId !== "string" || busy) return;
    busy = true;
    cancelled = false;
    const requestId = message.requestId;
    try {
      validateDocument(message.payload);
      const { report } = await convertDocument(message.payload, (count) => send({ type: "PROGRESS", requestId, count }), () => cancelled);
      send({ type: "COMPLETE", requestId, report });
      figma.notify(`${report.total}\uAC1C\uC758 \uD3B8\uC9D1 \uAC00\uB2A5\uD55C \uB808\uC774\uC5B4\uB97C \uC0DD\uC131\uD588\uC2B5\uB2C8\uB2E4.`);
    } catch (error) {
      send({ type: "ERROR", requestId, message: errorMessage(error) });
    } finally {
      busy = false;
    }
  };
})();

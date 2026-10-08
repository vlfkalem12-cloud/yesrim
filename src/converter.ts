import { LIMITS, type Color, type ConversionReport, type ParsedBackgroundLayer, type ParsedDocument, type ParsedGradient, type ParsedImage, type ParsedNode, type SizingMode } from './types';
import { clamp, errorMessage, isViewportDimension } from './utils';
import { enrichWarnings } from './report';
import { linearGradientPaint } from './gradients';
import { backgroundLayers, thinHorizontalGridLines, type BackgroundGridLine } from './backgrounds';
import { applyLayerNames } from './layer-naming';

type EditableNode = FrameNode | TextNode | RectangleNode;
const solid = (color: Color): SolidPaint => ({ type: 'SOLID', color: { r: clamp(color.r, 0, 1), g: clamp(color.g, 0, 1), b: clamp(color.b, 0, 1) }, opacity: clamp(color.a, 0, 1) });
const fontWeight = (style: string): number => {
  const value = style.toLowerCase().replace(/[\s_-]/g, '');
  if (/thin|hairline/.test(value)) return 100;
  if (/extralight|ultralight/.test(value)) return 200;
  if (/light/.test(value)) return 300;
  if (/medium/.test(value)) return 500;
  if (/semibold|demibold/.test(value)) return 600;
  if (/extrabold|ultrabold/.test(value)) return 800;
  if (/black|heavy/.test(value)) return 900;
  return /bold/.test(value) ? 700 : 400;
};

class FontResolver {
  private available: FontName[] = [];
  private cache = new Map<string, Promise<FontName | null>>();
  private loaded = new Map<string, Promise<boolean>>();
  constructor(private warn: (code: string, name: string, message: string) => void) {}
  async initialize(): Promise<void> {
    try { this.available = (await figma.listAvailableFontsAsync()).map(font => font.fontName); }
    catch { this.warn('FONT_LIST', 'document', '폰트 목록을 읽지 못해 기본 폰트를 직접 확인합니다.'); }
  }
  async resolve(node: ParsedNode, styles: boolean): Promise<FontName | null> {
    const requested = styles ? node.style.fontFamily.split(',').map(f => f.trim().replace(/^['"]|['"]$/g, '')) : ['Inter'];
    const weight = styles ? node.style.fontWeight : 400;
    const italic = styles && ['italic', 'oblique'].includes(node.style.fontStyle);
    const korean = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(node.text || '');
    const key = `${requested.join(',')}|${weight}|${italic}|${korean}`;
    if (!this.cache.has(key)) this.cache.set(key, this.find(requested, weight, italic, korean));
    const selected = await this.cache.get(key)!;
    if (selected && !requested.some(name => name.toLowerCase() === selected.family.toLowerCase())) {
      this.warn('FONT_REPLACED', node.name, `${requested.join(', ')} ${weight}${italic ? ' Italic' : ''} → ${selected.family} ${selected.style}`);
    } else if (selected && (Math.abs(fontWeight(selected.style) - weight) >= 100 || /italic|oblique/i.test(selected.style) !== italic)) {
      this.warn('FONT_STYLE_REPLACED', node.name, `사용 가능한 ${selected.family} ${selected.style}로 폰트 스타일을 대체했습니다.`);
    }
    if (!selected && korean) this.warn('KOREAN_FONT_UNAVAILABLE', node.name, '한글 지원을 확인할 수 있는 폰트가 없어 Latin 폰트 대신 placeholder를 생성합니다.');
    return selected;
  }
  private async load(font: FontName): Promise<boolean> {
    const key = `${font.family}|${font.style}`;
    if (!this.loaded.has(key)) this.loaded.set(key, figma.loadFontAsync(font).then(() => true, () => { this.warn('FONT_LOAD_FAILED', font.family, `${font.family} ${font.style} 로딩 실패`); return false; }));
    return this.loaded.get(key)!;
  }
  private supportsKorean(family: string): boolean {
    return /pretendard|noto sans (?:kr|cjk kr)|noto serif (?:kr|cjk kr)|nanum|malgun|apple sd gothic|spoqa han|d2coding|gulim|dotum|batang|함초롬|나눔|맑은 고딕|돋움|굴림|바탕/i.test(family);
  }
  private async find(requested: string[], weight: number, italic: boolean, korean: boolean): Promise<FontName | null> {
    const fallback = korean ? ['Pretendard', 'Noto Sans KR', 'Noto Sans CJK KR', 'Nanum Gothic', 'Malgun Gothic', 'Apple SD Gothic Neo'] : ['Pretendard', 'Inter', 'Arial', 'Roboto'];
    const families = [...new Set([...requested.filter(family => !korean || this.supportsKorean(family)), ...fallback])];
    for (const family of families) {
      const candidates = this.available.filter(font => font.family.toLowerCase() === family.toLowerCase());
      candidates.sort((a, b) => this.score(a, weight, italic) - this.score(b, weight, italic));
      if (!this.available.length) candidates.push({ family, style: weight >= 600 ? (italic ? 'Bold Italic' : 'Bold') : (italic ? 'Italic' : 'Regular') }, { family, style: 'Regular' });
      for (const font of candidates) {
        if (await this.load(font)) return font;
      }
    }
    // A local font list may not include the suggested families. Use any genuinely loadable font.
    for (const font of this.available.filter(font => !korean || this.supportsKorean(font.family)).sort((a, b) => this.score(a, weight, italic) - this.score(b, weight, italic))) {
      if (await this.load(font)) return font;
    }
    return null;
  }
  private score(font: FontName, weight: number, italic: boolean): number {
    return Math.abs(fontWeight(font.style) - weight) + (/italic|oblique/i.test(font.style) === italic ? 0 : 1000);
  }
}

/** Validate the UI message boundary before allocating nodes or applying sizing values. */
export function validateDocument(value: unknown): asserts value is ParsedDocument {
  if (!value || typeof value !== 'object') throw new Error('잘못된 변환 데이터입니다.');
  const doc = value as ParsedDocument;
  if (doc.version !== 1 || !doc.root || !doc.options || typeof doc.options.autoLayout !== 'boolean' || typeof doc.options.styles !== 'boolean' || !Array.isArray(doc.warnings) || doc.warnings.length > 1000) throw new Error('지원하지 않는 변환 형식입니다.');
  if (!isViewportDimension(doc.options.viewport) || !isViewportDimension(doc.options.viewportHeight)) throw new Error('Viewport 너비와 높이는 1~10,000px의 정수로 입력하세요.');
  for (const option of [doc.options.images, doc.options.shadows, doc.options.optimizeWrappers, doc.options.debug]) if (option !== undefined && typeof option !== 'boolean') throw new Error('잘못된 변환 옵션입니다.');
  for (const warning of doc.warnings) if (!warning || typeof warning.code !== 'string' || typeof warning.node !== 'string' || typeof warning.message !== 'string') throw new Error('잘못된 경고 데이터입니다.');
  const finite = (value: unknown, max: number = LIMITS.dimension) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max;
  const validateGradient = (gradient: ParsedGradient) => {
    if (!gradient || ![0, 90, 180, 270].includes(gradient.angle) || !Number.isInteger(gradient.layerIndex) || gradient.layerIndex < 0 || !Array.isArray(gradient.stops) || gradient.stops.length < 2 || gradient.stops.some((stop, index) => !stop || !finite(stop.position, 1) || stop.position < 0 || (index > 0 && stop.position < gradient.stops[index - 1]!.position) || !stop.color || ![stop.color.r, stop.color.g, stop.color.b, stop.color.a].every(value => finite(value, 1) && value >= 0))) throw new Error('잘못된 Gradient 데이터입니다.');
  };
  const stack = [{ node: doc.root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > LIMITS.nodes || depth > LIMITS.depth) throw new Error('문서의 노드 수 또는 깊이 제한을 초과했습니다.');
    if (!node || !['FRAME', 'TEXT', 'IMAGE', 'SVG'].includes(node.type) || typeof node.name !== 'string' || typeof node.tagName !== 'string' || !Array.isArray(node.children) || !node.size || !node.layout || !node.style || !node.rect) throw new Error('잘못된 노드 데이터입니다.');
    if (node.layerName !== undefined && (typeof node.layerName !== 'string' || node.layerName.length > 160)) throw new Error('잘못된 Layer Name 데이터입니다.');
    if (node.svg !== undefined && (typeof node.svg !== 'string' || node.svg.length > LIMITS.fileBytes)) throw new Error('잘못된 SVG 데이터입니다.');
    if (node.type === 'TEXT' && (typeof node.text !== 'string' || node.text.length > 1000000)) throw new Error('잘못된 텍스트 데이터입니다.');
    if (node.ranges !== undefined && (node.type !== 'TEXT' || !Array.isArray(node.ranges) || node.ranges.some((range, index) =>
      !range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.start >= range.end || range.end > node.text!.length ||
      (index > 0 && range.start < node.ranges![index - 1]!.end) || !range.style || typeof range.style.fontFamily !== 'string' ||
      typeof range.style.fontStyle !== 'string' || typeof range.style.textDecoration !== 'string' ||
      ![range.style.fontSize, range.style.fontWeight, range.style.letterSpacing].every(value => finite(value)) || range.style.fontSize <= 0 ||
      (range.style.lineHeight !== null && (!finite(range.style.lineHeight) || range.style.lineHeight < 0)) ||
      (range.style.color && ![range.style.color.r, range.style.color.g, range.style.color.b, range.style.color.a].every(value => finite(value, 1) && value >= 0))))) throw new Error('잘못된 Rich Text Range 데이터입니다.');
    if (!finite(node.size.width) || !finite(node.size.height) || node.size.width < 0 || node.size.height < 0 || !['FIXED', 'FILL', 'HUG'].includes(node.size.widthMode) || !['FIXED', 'FILL', 'HUG'].includes(node.size.heightMode)) throw new Error('잘못된 크기 데이터입니다.');
    for (const value of [node.size.minWidth, node.size.maxWidth, node.size.minHeight, node.size.maxHeight]) if (value !== undefined && value !== null && (!finite(value) || value < 0)) throw new Error('잘못된 최소/최대 크기입니다.');
    if (node.style.shadow && (!node.style.shadow.color || ![node.style.shadow.x, node.style.shadow.y, node.style.shadow.blur, node.style.shadow.spread].every(value => finite(value)))) throw new Error('잘못된 그림자 데이터입니다.');
    const gradient = node.style.backgroundGradient;
    if (gradient) validateGradient(gradient);
    if (node.style.backgroundGridFallback !== undefined && typeof node.style.backgroundGridFallback !== 'boolean') throw new Error('잘못된 Background Grid 데이터입니다.');
    if (node.style.backgroundSource !== undefined && (!node.style.backgroundSource ||
      !['background', 'backgroundImage', 'backgroundColor', 'backgroundSize', 'backgroundPosition'].every(key => {
        const value = node.style.backgroundSource![key as keyof NonNullable<typeof node.style.backgroundSource>];
        return typeof value === 'string' && value.length <= LIMITS.fileBytes;
      }))) throw new Error('잘못된 Background Debug 데이터입니다.');
    if (node.style.backgroundLayers !== undefined) {
      if (!Array.isArray(node.style.backgroundLayers)) throw new Error('잘못된 Background Layer 데이터입니다.');
      for (const layer of node.style.backgroundLayers) {
        if (!layer || !['GRADIENT', 'IMAGE', 'SOLID'].includes(layer.type)) throw new Error('잘못된 Background Layer 데이터입니다.');
        if (layer.type === 'GRADIENT') validateGradient(layer.gradient);
        if (layer.type === 'IMAGE' && (!layer.image || ![layer.image.key, layer.image.src, layer.image.fit].every(value => typeof value === 'string'))) throw new Error('잘못된 Background Image 데이터입니다.');
        if (layer.type === 'SOLID' && (!layer.color || ![layer.color.r, layer.color.g, layer.color.b, layer.color.a].every(value => finite(value, 1) && value >= 0) || !Number.isInteger(layer.layerIndex) || layer.layerIndex < 0 || (layer.base !== undefined && typeof layer.base !== 'boolean'))) throw new Error('잘못된 Background Color 데이터입니다.');
      }
    }
    if (!['HORIZONTAL', 'VERTICAL', 'NONE'].includes(node.layout.direction) || !['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'].includes(node.layout.justify) || !['MIN', 'CENTER', 'MAX', 'BASELINE'].includes(node.layout.align) || !finite(node.layout.gap) || !finite(node.layout.order)) throw new Error('잘못된 레이아웃 데이터입니다.');
    if (node.layout.fixedInsets && !(['top', 'right', 'bottom', 'left'] as const).every(side => {
      const value = node.layout.fixedInsets![side];
      return value === null || finite(value);
    })) throw new Error('잘못된 Fixed Viewport 좌표입니다.');
    for (const inset of [node.layout.padding, node.layout.margin, node.style.borderWidths]) if (!inset || ![inset.top, inset.right, inset.bottom, inset.left].every(v => finite(v))) throw new Error('잘못된 여백 데이터입니다.');
    if (![node.rect.x, node.rect.y, node.rect.width, node.rect.height, node.style.opacity, node.style.fontSize, node.style.fontWeight, node.style.letterSpacing, ...node.style.radii].every(v => finite(v))) throw new Error('잘못된 스타일 치수입니다.');
    for (const color of [node.style.background, node.style.color, node.style.shadow?.color, ...node.style.borderColors]) if (color && ![color.r, color.g, color.b, color.a].every(v => finite(v, 1) && v >= 0)) throw new Error('잘못된 색상입니다.');
    if (typeof node.style.fontFamily !== 'string' || (node.style.lineHeight !== null && !finite(node.style.lineHeight))) throw new Error('잘못된 글꼴 데이터입니다.');
    if (node.type !== 'FRAME' && node.children.length) throw new Error('Frame이 아닌 노드에 자식이 있습니다.');
    stack.push(...node.children.map(child => ({ node: child, depth: depth + 1 })));
  }
  if (!doc.assets || typeof doc.assets !== 'object') throw new Error('이미지 데이터가 없습니다.');
  let assetBytes = 0;
  for (const bytes of Object.values(doc.assets)) {
    if (!Array.isArray(bytes) || bytes.length > LIMITS.imageBytes || !bytes.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) throw new Error('잘못된 이미지 데이터입니다.');
    assetBytes += bytes.length;
    if (assetBytes > LIMITS.assetBytes) throw new Error('이미지 용량 제한을 초과했습니다.');
  }
}

export async function convertDocument(doc: ParsedDocument, onProgress: (count: number) => void = () => {}, cancelled: () => boolean = () => false): Promise<{ frame: FrameNode; report: ConversionReport }> {
  validateDocument(doc);
  const started = Date.now();
  const report: ConversionReport = { total: 0, autoLayout: 0, text: 0, image: 0, frames: 0, grid: 0, absolute: 0, svg: 0, durationMs: 0, warningGroups: {}, warnings: doc.warnings.map(warning => ({ ...warning })) };
  const seen = new Set(report.warnings.map(w => `${w.code}|${w.node}|${w.message}`));
  const warn = (code: string, node: string, message: string) => {
    const key = `${code}|${node}|${message}`;
    if (!seen.has(key) && report.warnings.length < 1000) { report.warnings.push({ code, node, message }); seen.add(key); }
  };
  const fonts = new FontResolver(warn);
  await fonts.initialize();
  const imageHashes = new Map<string, string>();
  const placements: { node: EditableNode; parsed: ParsedNode; parent: FrameNode; parentParsed: ParsedNode }[] = [];
  const fixedPlacements: { node: EditableNode; parsed: ParsedNode }[] = [];
  const gridBackgrounds: { node: FrameNode; parsed: ParsedNode; lines: BackgroundGridLine[] }[] = [];
  const backgroundDiagnostics: { node: FrameNode | RectangleNode; parsed: ParsedNode; layers: ParsedBackgroundLayer[] }[] = [];
  const namingAssignments: { node: SceneNode; parsed: ParsedNode; margin?: boolean }[] = [];
  const isFixed = (parsed: ParsedNode) => parsed.layout.absolute && parsed.layout.position === 'fixed';
  let root: FrameNode | undefined;
  function imagePaint(image: ParsedImage, name: string): ImagePaint | null {
    try {
      if (!image.key || !doc.assets[image.key]) throw new Error('이미지 데이터가 없습니다.');
      if (!imageHashes.has(image.key)) imageHashes.set(image.key, figma.createImage(new Uint8Array(doc.assets[image.key]!)).hash);
      if (image.position && !['center', 'center center', '50% 50%'].includes(image.position)) warn('BACKGROUND_POSITION', name, `background-position:${image.position}를 center로 단순화합니다.`);
      if (image.repeat && image.repeat !== 'no-repeat') warn('BACKGROUND_REPEAT', name, '반복 배경은 단일 Image Fill로 단순화합니다.');
      if (image.fit && !['cover', 'contain', 'fill'].includes(image.fit)) warn('BACKGROUND_SIZE', name, `background-size:${image.fit}를 cover로 단순화합니다.`);
      return { type: 'IMAGE', imageHash: imageHashes.get(image.key)!, scaleMode: image.fit === 'contain' ? 'FIT' : 'FILL' };
    } catch (error) { warn('IMAGE_PLACEHOLDER', name, `${image.src.slice(0, 180)} — ${errorMessage(error)}`); return null; }
  }
  function applyStacking(frame: FrameNode, children: { parsed: ParsedNode; node: EditableNode }[]): void {
    if (!children.some(child => child.parsed.layout.zIndex !== null && child.parsed.layout.zIndex !== undefined)) return;
    const flow = children.filter(child => !child.parsed.layout.absolute).map(child => child.node);
    const sorted = [...children].sort((a, b) => (a.parsed.layout.zIndex || 0) - (b.parsed.layout.zIndex || 0));
    const sameFlow = (items: typeof children) => items.filter(child => !child.parsed.layout.absolute).every((child, index) => child.node === flow[index]);
    if (frame.layoutMode === 'NONE' || sameFlow(sorted)) sorted.forEach((child, index) => frame.insertChild(index, child.node));
    else if (sameFlow([...sorted].reverse())) {
      frame.itemReverseZIndex = true;
      [...sorted].reverse().forEach((child, index) => frame.insertChild(index, child.node));
    } else {
      // Reordering flow layers would also change Auto Layout positions. Move only absolute layers.
      for (const child of sorted.filter(child => child.parsed.layout.absolute)) {
        const next = children.find(flowChild => !flowChild.parsed.layout.absolute && (flowChild.parsed.layout.zIndex || 0) > (child.parsed.layout.zIndex || 0));
        const index = next ? frame.children.indexOf(next.node) : frame.children.length;
        frame.insertChild(index, child.node);
      }
      warn('Z_INDEX_FLOW', frame.name, '복잡한 flow 자식의 z-index는 Auto Layout 위치를 유지하며 단순화했습니다. Absolute 레이어 순서는 적용했습니다.');
    }
  }

  function applyBoxStyle(node: FrameNode | RectangleNode, parsed: ParsedNode): void {
    const style = parsed.style;
    const layers = backgroundLayers(style);
    const baseLayer = layers.find(layer => layer.type === 'SOLID' && layer.base);
    const base: Paint[] = doc.options.styles && baseLayer?.type === 'SOLID' ? [solid(baseLayer.color)] : [];
    node.fills = base;
    node.strokes = [];
    if (!doc.options.styles) return;
    const indexOf = (layer: ParsedBackgroundLayer) => layer.type === 'GRADIENT' ? layer.gradient.layerIndex : layer.type === 'IMAGE' ? layer.image.layerIndex ?? 0 : layer.layerIndex;
    const applied: Paint[] = [];
    for (const layer of layers) {
      if (layer.type === 'SOLID' && layer.base) continue;
      if (layer.type === 'IMAGE' && doc.options.images === false) continue;
      let paint = layer.type === 'GRADIENT' ? linearGradientPaint(layer.gradient) : layer.type === 'IMAGE' ? imagePaint(layer.image, parsed.name) : solid(layer.color);
      if (!paint) continue;
      // Both CSS and Figma fills list the top paint first. Keep the solid background at the bottom.
      // Apply incrementally so rejection of one layer cannot discard previously accepted paints.
      try { node.fills = [...applied, paint, ...base]; }
      catch (error) {
        if (layer.type !== 'GRADIENT') {
          warn('BACKGROUND_LAYER', parsed.name, `Background Layer ${indexOf(layer) + 1} 적용 실패: ${errorMessage(error)}`);
          continue;
        }
        paint = solid(layer.gradient.stops[0]!.color);
        node.fills = [...applied, paint, ...base];
        warn('GRADIENT_FALLBACK', parsed.name, `Background Layer ${indexOf(layer) + 1}: Gradient Paint 적용 실패: ${errorMessage(error)}. 첫 번째 color stop을 Solid Fill로 사용합니다.`);
      }
      applied.push(paint);
      if (layer.type === 'IMAGE') node.setPluginData('html-background-image', 'true');
    }
    const lines = style.backgroundGridFallback && node.type === 'FRAME' && parsed.type === 'FRAME' ? thinHorizontalGridLines(layers) : null;
    if (lines && node.type === 'FRAME') gridBackgrounds.push({ node, parsed, lines });
    if (doc.options.debug && style.backgroundLayers?.length) backgroundDiagnostics.push({ node, parsed, layers });
    node.opacity = clamp(style.opacity, 0, 1);
    if (doc.options.shadows !== false && style.shadow) {
      const shadow = style.shadow;
      let effect: DropShadowEffect | InnerShadowEffect = { type: shadow.inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color: shadow.color, offset: { x: shadow.x, y: shadow.y }, radius: shadow.blur, visible: true, blendMode: 'NORMAL' };
      if (shadow.spread !== 0) {
        if (node.type === 'RECTANGLE' || (parsed.style.clipsContent && (node.fills as Paint[]).some(paint => paint.visible !== false))) effect = { ...effect, spread: shadow.spread };
        else warn('SHADOW_SPREAD', parsed.name, '이 Frame에서는 Figma API가 shadow spread를 지원하지 않아 blur와 offset만 반영했습니다.');
      }
      node.effects = [effect];
    }
    [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] = style.radii.map(v => clamp(v)) as [number, number, number, number];
    const { top, right, bottom, left } = style.borderWidths;
    if ([top, right, bottom, left].some(v => v > 0)) {
      const borderColor = style.borderColors.find((color, i) => color && [top, right, bottom, left][i]! > 0);
      if (borderColor) node.strokes = [solid(borderColor)];
      node.strokeAlign = 'INSIDE';
      node.strokeTopWeight = clamp(top); node.strokeRightWeight = clamp(right); node.strokeBottomWeight = clamp(bottom); node.strokeLeftWeight = clamp(left);
      if (new Set(style.borderColors.map(color => JSON.stringify(color))).size > 1) warn('BORDER_COLORS', parsed.name, '서로 다른 테두리 색상은 첫 번째 색상으로 통합했습니다.');
    }
  }
  function createBackgroundGrid(node: FrameNode, parsed: ParsedNode, lines: BackgroundGridLine[]): void {
    const rectangles: RectangleNode[] = [];
    const original = node.fills as Paint[];
    try {
      for (const [index, line] of lines.entries()) {
        const rectangle = figma.createRectangle(); rectangles.push(rectangle);
        rectangle.name = `Grid Line / ${Math.round(line.position * 10000) / 100}%`;
        rectangle.fills = [solid(line.color)]; rectangle.strokes = [];
        // Children are back-to-front. Respect reverse stacking without changing content order.
        node.insertChild(node.itemReverseZIndex ? node.children.length : index, rectangle);
        if (node.layoutMode !== 'NONE') rectangle.layoutPositioning = 'ABSOLUTE';
        rectangle.resizeWithoutConstraints(node.width, 1);
        rectangle.x = 0; rectangle.y = Math.max(0, Math.min(node.height - 1, Math.round(node.height * line.position)));
        // Absolute layers cannot use Auto Layout FILL; STRETCH provides the same full-width behavior.
        rectangle.constraints = { horizontal: 'STRETCH', vertical: 'MIN' };
        rectangle.setPluginData('html-background-grid-line', String(line.position));
      }
      // Retain all source Paints/stops for inspection, but avoid drawing the gradient and rectangle twice.
      node.fills = original.map(paint => paint.type === 'GRADIENT_LINEAR' ? { ...paint, visible: false } : paint);
      node.setPluginData('html-background-grid-fallback', 'true');
    } catch (error) {
      for (const rectangle of rectangles) if (!rectangle.removed) rectangle.remove();
      node.fills = original;
      warn('BACKGROUND_GRID_FALLBACK', parsed.name, `Grid Line Rectangle 생성 실패로 원본 Gradient Fill을 유지합니다: ${errorMessage(error)}`);
    }
  }
  function debugBackground(node: FrameNode | RectangleNode, parsed: ParsedNode, layers: ParsedBackgroundLayer[]): void {
    const fills = node.fills as Paint[];
    const color = (value: Color) => `#${[value.r, value.g, value.b].map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}${value.a === 1 ? '' : ` alpha=${value.a}`}`;
    const details = layers.map((layer, index) => `- layer ${index + 1}: ${layer.type === 'GRADIENT' ? `linear-gradient (${layer.gradient.angle}deg; ${layer.gradient.stops.map(stop => `${Math.round(stop.position * 10000) / 100}% alpha=${stop.color.a} ${color(stop.color)}`).join(', ')})` : layer.type === 'IMAGE' ? 'image' : `solid ${color(layer.color)}`}`);
    const rectangles = node.type === 'FRAME' ? node.children.filter(child => child.getPluginData('html-background-grid-line')) : [];
    const diagnostics = { computed: parsed.style.backgroundSource, backgroundLayers: layers, figmaFills: fills, renderOrder: 'first paint on top; solid base last',
      gridLines: rectangles.map(rectangle => ({ name: rectangle.name, x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height })) };
    node.setPluginData('html-background-debug', JSON.stringify(diagnostics));
    console.info('HTML → Figma background', parsed.source?.selector || parsed.name, diagnostics);
    warn('BACKGROUND_DEBUG', parsed.name, [
      ...(parsed.style.backgroundSource ? [`computed backgroundImage: ${parsed.style.backgroundSource.backgroundImage}`, `computed background: ${parsed.style.backgroundSource.background}`] : []),
      `background layers: ${layers.length}`, ...details, `figma fills: ${fills.length}`, 'order: CSS first layer → top Paint; solid base → bottom Paint',
      ...(rectangles.length ? [`Grid Line fallback: ${rectangles.length} Rectangles; original Gradient Paints hidden; visible fills: ${fills.filter(paint => paint.visible !== false).length}`] : [])
    ].join('\n'));
  }
  function configureLayout(frame: FrameNode, parsed: ParsedNode): void {
    frame.layoutMode = doc.options.autoLayout ? parsed.layout.direction : 'NONE';
    frame.clipsContent = parsed.style.clipsContent;
    if (frame.layoutMode === 'NONE') return;
    frame.primaryAxisSizingMode = 'FIXED'; frame.counterAxisSizingMode = 'FIXED';
    frame.primaryAxisAlignItems = parsed.layout.justify;
    frame.counterAxisAlignItems = parsed.layout.align;
    frame.itemSpacing = clamp(parsed.layout.gap);
    frame.paddingTop = clamp(parsed.layout.padding.top); frame.paddingRight = clamp(parsed.layout.padding.right);
    frame.paddingBottom = clamp(parsed.layout.padding.bottom); frame.paddingLeft = clamp(parsed.layout.padding.left);
    frame.strokesIncludedInLayout = true;
  }
  function applySizing(node: EditableNode, parsed: ParsedNode, parent: FrameNode | undefined, absolute: boolean): void {
    const autoParent = !!parent && parent.layoutMode !== 'NONE' && !absolute;
    const autoFrame = node.type === 'FRAME' && node.layoutMode !== 'NONE';
    const canHug = node.type === 'TEXT' || autoFrame;
    if (node.type === 'TEXT') {
      // Text auto width is independent of whether its parent uses Auto Layout.
      const intrinsic = parsed.size.widthMode === 'HUG';
      node.textAutoResize = intrinsic ? 'WIDTH_AND_HEIGHT' : parsed.ranges !== undefined ? 'HEIGHT' : !doc.options.autoLayout ? 'NONE' : parsed.size.heightMode === 'HUG' ? 'HEIGHT' : 'NONE';
    }
    const mode = (requested: SizingMode, horizontal: boolean): SizingMode => {
      if (!doc.options.autoLayout) return 'FIXED';
      // Opposing viewport insets define an auto-sized fixed box, even when it is a flex frame.
      const offsets = parsed.layout.offsets;
      if (isFixed(parsed) && (horizontal
        ? parsed.size.authoredWidth === 'auto' && offsets.left !== 'auto' && offsets.right !== 'auto'
        : parsed.size.authoredHeight === 'auto' && offsets.top !== 'auto' && offsets.bottom !== 'auto')) return 'FIXED';
      if (requested === 'FILL' && !autoParent) return 'FIXED';
      if (requested === 'HUG' && !canHug) return 'FIXED';
      if (requested === 'HUG' && node.type === 'FRAME' && node.children.some(child => 'layoutPositioning' in child && 'layoutSizingHorizontal' in child && child.layoutPositioning !== 'ABSOLUTE' && (horizontal ? child.layoutSizingHorizontal : child.layoutSizingVertical) === 'FILL')) {
        warn('SIZING_CYCLE', parsed.name, 'Hug 부모와 Fill 자식의 순환 크기를 피하려고 부모의 측정 치수를 고정했습니다.');
        return 'FIXED';
      }
      return requested;
    };
    // Standalone text uses textAutoResize; avoid runtime-dependent Auto Layout setters there.
    if (autoFrame || autoParent) {
      try {
        node.layoutSizingHorizontal = mode(parsed.size.widthMode, true);
        node.layoutSizingVertical = mode(parsed.size.heightMode, false);
      } catch (error) {
        // An optional sizing property must not delete this node and its entire descendant tree.
        warn('SIZING_API', parsed.name, `일부 Auto Layout 크기 설정을 적용하지 못했지만 노드와 자식 구조를 유지합니다: ${errorMessage(error)}`);
      }
    }
    for (const key of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) {
      const value = parsed.size[key];
      if (value === undefined || value === null) continue;
      if (value === 0 && key.startsWith('min')) continue;
      if (value === 0) { warn('SIZE_CONSTRAINT', parsed.name, `${key}:0px는 Figma API에서 직접 지원하지 않아 측정 크기로 유지합니다.`); continue; }
      if (autoParent || (node.type === 'FRAME' && node.layoutMode !== 'NONE')) {
        try { node[key] = value; }
        catch { warn('SIZE_CONSTRAINT', parsed.name, `${key}:${value}px는 측정 크기로 유지합니다.`); }
      } else warn('SIZE_CONSTRAINT', parsed.name, `${key}:${value}px는 고정 치수에 반영되어 있습니다.`);
    }
    if (autoParent && parsed.layout.alignSelf !== 'auto' && !['stretch', 'normal'].includes(parsed.layout.alignSelf)) {
      const alignment = parsed.layout.alignSelf.includes('center') ? 'CENTER' : parsed.layout.alignSelf.includes('end') ? 'MAX' : 'MIN';
      if (alignment !== parent.counterAxisAlignItems) warn('ALIGN_SELF', parsed.name, '개별 align-self 정렬은 부모의 정렬로 단순화했습니다.');
    }
  }
  function place(node: EditableNode, parsed: ParsedNode, parent: FrameNode | undefined, parentParsed: ParsedNode | undefined): void {
    if (!parent || !parentParsed) return;
    if (parent.layoutMode !== 'NONE' && parsed.layout.absolute) node.layoutPositioning = 'ABSOLUTE';
    if (parent.layoutMode === 'NONE' || parsed.layout.absolute) {
      node.x = parsed.rect.x - parentParsed.rect.x;
      node.y = parsed.rect.y - parentParsed.rect.y;
      if (parsed.layout.absolute && parsed.layout.offsets) {
        const offsets = parsed.layout.offsets;
        // Hug text can change size with the loaded Figma font; retain authored right/bottom anchors.
        if (offsets.left === 'auto' && offsets.right !== 'auto') node.x += parsed.rect.width - node.width;
        if (offsets.top === 'auto' && offsets.bottom !== 'auto') node.y += parsed.rect.height - node.height;
        // A fixed parent may have been resized from a DOM containing block to the viewport.
        // Its absolute descendants keep their own parent anchors, never viewport anchors.
        if (isFixed(parentParsed)) {
          if (offsets.left === 'auto' && offsets.right !== 'auto') node.x += parent.width - parentParsed.rect.width;
          if (offsets.top === 'auto' && offsets.bottom !== 'auto') node.y += parent.height - parentParsed.rect.height;
        }
        node.constraints = { horizontal: offsets.left !== 'auto' && offsets.right !== 'auto' ? 'STRETCH' : offsets.right !== 'auto' ? 'MAX' : 'MIN', vertical: offsets.top !== 'auto' && offsets.bottom !== 'auto' ? 'STRETCH' : offsets.bottom !== 'auto' ? 'MAX' : 'MIN' };
      }
    }
  }
  function placeFixed(node: EditableNode, parsed: ParsedNode, viewportFrame: FrameNode): void {
    viewportFrame.appendChild(node);
    if (viewportFrame.layoutMode !== 'NONE') node.layoutPositioning = 'ABSOLUTE';
    const { viewport: width, viewportHeight: height } = doc.options;
    // Compatibility with earlier version-1 JSON: resolve simple CSS lengths without a DOM.
    const length = (value: string, extent: number): number | null => /^-?\d*\.?\d+(px|%)$/.test(value) ? parseFloat(value) * (value.endsWith('%') ? extent / 100 : 1) : null;
    const { top, right, bottom, left } = parsed.layout.fixedInsets || {
      top: length(parsed.layout.offsets.top, height), right: length(parsed.layout.offsets.right, width),
      bottom: length(parsed.layout.offsets.bottom, height), left: length(parsed.layout.offsets.left, width)
    };
    const margin = parsed.layout.margin;
    // Auto sizes with opposing insets also use the viewport, even if the measured DOM parent is narrower/taller.
    const stretchedWidth = parsed.size.authoredWidth === 'auto' && left !== null && right !== null;
    const stretchedHeight = parsed.size.authoredHeight === 'auto' && top !== null && bottom !== null;
    if (stretchedWidth || stretchedHeight) {
      const bounded = (value: number, min: number | null | undefined, max: number | null | undefined) => clamp(Math.max(min ?? 0, Math.min(max ?? LIMITS.dimension, value)), 0.01);
      const horizontalSizing = node.layoutSizingHorizontal, verticalSizing = node.layoutSizingVertical;
      node.resizeWithoutConstraints(
        stretchedWidth ? bounded(width - left! - right! - margin.left - margin.right, parsed.size.minWidth, parsed.size.maxWidth) : node.width,
        stretchedHeight ? bounded(height - top! - bottom! - margin.top - margin.bottom, parsed.size.minHeight, parsed.size.maxHeight) : node.height
      );
      // Figma resize can turn both axes into Fixed. Preserve the other axis's existing Hug policy.
      if (node.type === 'FRAME' && node.layoutMode !== 'NONE') {
        try { node.layoutSizingHorizontal = horizontalSizing; node.layoutSizingVertical = verticalSizing; }
        catch (error) { warn('SIZING_API', parsed.name, `Viewport 크기는 유지하지만 일부 크기 설정을 복원하지 못했습니다: ${errorMessage(error)}`); }
      }
    }
    // Do not derive right/bottom from the source rect: its containing block may be a tall document parent.
    node.x = left !== null ? left + margin.left : right !== null ? width - right - margin.right - node.width : parsed.rect.x;
    node.y = top !== null ? top + margin.top : bottom !== null ? height - bottom - margin.bottom - node.height : parsed.rect.y;
    // MAX/STRETCH would anchor to the full document height, not the selected viewport height.
    node.constraints = { horizontal: 'MIN', vertical: 'MIN' };
    if (doc.options.debug) {
      node.setPluginData('html-fixed-position', JSON.stringify({ viewport: { width, height }, x: node.x, y: node.y }));
      warn('FIXED_POSITION', parsed.name, `[fixed] viewport: ${width}×${height}, x: ${node.x}, y: ${node.y}`);
    }
  }
  function countNode(node: EditableNode): void {
    report.total++;
    if (node.type === 'TEXT') report.text++;
    if (node.type === 'FRAME' && node.layoutMode !== 'NONE') report.autoLayout++;
  }
  async function create(parsed: ParsedNode, parent?: FrameNode, parentParsed?: ParsedNode): Promise<EditableNode> {
    if (cancelled()) throw new Error('변환을 취소했습니다.');
    let node: EditableNode | undefined;
    let marginWrapper: FrameNode | undefined;
    try {
      if (parsed.type === 'TEXT') {
        const font = await fonts.resolve(parsed, doc.options.styles);
        if (!font) {
          node = figma.createRectangle(); node.fills = [solid({ r: 0.95, g: 0.8, b: 0.8, a: 1 })];
          warn('FONT_UNAVAILABLE', parsed.name, '로드할 수 있는 폰트가 없어 텍스트를 placeholder로 대체했습니다.');
        } else {
          const text = figma.createText(); node = text;
          // Load before setting characters or text properties, including fontName.
          text.fontName = font; text.characters = parsed.text || '';
          text.fontSize = doc.options.styles ? parsed.style.fontSize : 16;
          text.fills = [solid(doc.options.styles && parsed.style.color ? parsed.style.color : { r: 0.1, g: 0.1, b: 0.1, a: 1 })];
          if (doc.options.styles) {
            text.opacity = clamp(parsed.style.opacity, 0, 1);
            text.lineHeight = parsed.style.lineHeight !== null ? { unit: 'PIXELS', value: clamp(parsed.style.lineHeight, 0.01) } : { unit: 'AUTO' };
            text.letterSpacing = { unit: 'PIXELS', value: parsed.style.letterSpacing };
            text.textAlignHorizontal = parsed.style.textAlign === 'center' ? 'CENTER' : ['right', 'end'].includes(parsed.style.textAlign) ? 'RIGHT' : parsed.style.textAlign === 'justify' ? 'JUSTIFIED' : 'LEFT';
            text.textDecoration = parsed.style.textDecoration.includes('underline') ? 'UNDERLINE' : parsed.style.textDecoration.includes('line-through') ? 'STRIKETHROUGH' : 'NONE';
            // Load every range font first; one unavailable style must not discard the sentence.
            const rangeFonts = await Promise.all((parsed.ranges || []).map(range => fonts.resolve({ ...parsed, text: parsed.text!.slice(range.start, range.end), style: { ...parsed.style, ...range.style } }, true)));
            for (const [index, range] of (parsed.ranges || []).entries()) {
              try {
                const rangeFont = rangeFonts[index];
                if (rangeFont) text.setRangeFontName(range.start, range.end, rangeFont);
                text.setRangeFills(range.start, range.end, [solid(range.style.color || parsed.style.color || { r: .1, g: .1, b: .1, a: 1 })]);
                text.setRangeFontSize(range.start, range.end, clamp(range.style.fontSize, 1, 1000));
                text.setRangeLetterSpacing(range.start, range.end, { unit: 'PIXELS', value: range.style.letterSpacing });
                text.setRangeTextDecoration(range.start, range.end, range.style.textDecoration.includes('underline') ? 'UNDERLINE' : range.style.textDecoration.includes('line-through') ? 'STRIKETHROUGH' : 'NONE');
                text.setRangeLineHeight(range.start, range.end, range.style.lineHeight === null ? { unit: 'AUTO' } : { unit: 'PIXELS', value: clamp(range.style.lineHeight, .01) });
              } catch (error) { warn('TEXT_RANGE_STYLE', parsed.name, `Rich Text ${range.start}~${range.end} 스타일 일부를 기본값으로 유지합니다: ${errorMessage(error)}`); }
            }
          }
        }
      } else if (parsed.type === 'SVG') {
        try { if (!parsed.svg) throw new Error('SVG 데이터가 없습니다.'); node = figma.createNodeFromSvg(parsed.svg); node.setPluginData('html-type', 'svg'); }
        catch (error) { node = figma.createFrame(); node.fills = []; warn('SVG_IMPORT', parsed.name, `Vector 변환 실패: ${errorMessage(error)}`); }
        node.opacity = doc.options.styles ? parsed.style.opacity : 1;
      } else if (parsed.type === 'IMAGE') {
        const image = figma.createRectangle(); node = image;
        image.setPluginData('html-type', doc.options.images === false ? 'image-disabled' : 'image');
        applyBoxStyle(image, parsed);
        if (doc.options.images !== false && parsed.image) {
          const paint = imagePaint(parsed.image, parsed.name);
          if (parsed.image?.fit === 'fill') warn('IMAGE_STRETCH', parsed.name, 'object-fit:fill은 비율을 유지하는 Image Fill로 단순화합니다.');
          image.fills = paint ? [paint] : [solid({ r: 0.89, g: 0.91, b: 0.94, a: 1 })];
        }
        report.image++;
      } else {
        const frame = figma.createFrame(); node = frame;
        if (!parent) root = frame;
        configureLayout(frame, parsed); applyBoxStyle(frame, parsed);
      }
      node.name = doc.options.debug && parsed.source ? `${parsed.name} [${parsed.source.selector}]` : parsed.name;
      node.setPluginData('html-source', parsed.source?.selector || parsed.tagName);
      namingAssignments.push({ node, parsed });
      if (parsed.grid?.supported) node.setPluginData('html-grid', 'true');
      if (parsed.layout.absolute) node.setPluginData('html-absolute', 'true');
      if (isFixed(parsed)) node.setPluginData('html-position', 'fixed');
      node.resize(clamp(parsed.size.width, 0.01), clamp(parsed.size.height, 0.01));
      // Record before recursion so a nested fixed layer paints above its parent at equal z-index.
      if (parent && isFixed(parsed)) fixedPlacements.push({ node, parsed });
      // CSS margins have no native Figma equivalent. Add an unpainted padding wrapper in flex flow.
      const margin = parsed.layout.margin;
      const autoParent = !!parent && parent.layoutMode !== 'NONE' && !parsed.layout.absolute;
      if (autoParent && Object.values(margin).some(v => v !== 0)) {
        if (Object.values(margin).some(v => v < 0)) warn('NEGATIVE_MARGIN', parsed.name, '음수 margin은 0으로 단순화했습니다.');
        const top = Math.max(0, margin.top), right = Math.max(0, margin.right), bottom = Math.max(0, margin.bottom), left = Math.max(0, margin.left);
        marginWrapper = figma.createFrame(); marginWrapper.name = `${parsed.name} / margin${doc.options.debug && parsed.source ? ` [${parsed.source.selector} / margin]` : ''}`; marginWrapper.fills = []; marginWrapper.clipsContent = false;
        marginWrapper.layoutMode = 'VERTICAL'; marginWrapper.primaryAxisSizingMode = 'FIXED'; marginWrapper.counterAxisSizingMode = 'FIXED';
        marginWrapper.paddingTop = top; marginWrapper.paddingRight = right; marginWrapper.paddingBottom = bottom; marginWrapper.paddingLeft = left;
        marginWrapper.resize(clamp(parsed.size.width + left + right, 0.01), clamp(parsed.size.height + top + bottom, 0.01));
        namingAssignments.push({ node: marginWrapper, parsed, margin: true });
        parent.appendChild(marginWrapper); marginWrapper.appendChild(node);
        marginWrapper.layoutSizingHorizontal = parsed.size.widthMode === 'FILL' ? 'FILL' : 'FIXED';
        marginWrapper.layoutSizingVertical = parsed.size.heightMode === 'FILL' ? 'FILL' : 'FIXED';
        countNode(marginWrapper);
      } else if (parent) parent.appendChild(node);
      // Absolute children must leave their parent's flow before their own descendants are created.
      if (parent && parent.layoutMode !== 'NONE' && parsed.layout.absolute) node.layoutPositioning = 'ABSOLUTE';
      if (node.type === 'FRAME' && parsed.type === 'FRAME') {
        // Every HTML frame recurses, including Normal Flow and absolute-positioned frames.
        // Only ordering/placement depends on Auto Layout; child creation is unconditional.
        let children = [...parsed.children];
        if (node.layoutMode !== 'NONE') {
          children.sort((a, b) => a.layout.order - b.layout.order);
          if (parsed.layout.reverse) children.reverse();
        }
        const childNodes: { parsed: ParsedNode; node: EditableNode }[] = [];
        const growers = children.filter(child => !child.layout.absolute && child.layout.grow > 0);
        if (new Set(growers.map(child => child.layout.grow)).size > 1) {
          warn('FLEX_GROW_RATIO', parsed.name, '서로 다른 flex-grow 비율은 측정된 px 치수로 유지합니다.');
          children = children.map(child => child.layout.grow > 0 ? { ...child, size: { ...child.size, [parsed.layout.direction === 'VERTICAL' ? 'heightMode' : 'widthMode']: 'FIXED' } } : child);
        }
        for (const child of children) {
          try { childNodes.push({ parsed: child, node: await create(child, node, parsed) }); }
          catch (error) {
            if (cancelled()) throw error;
            warn('NODE_FAILED', child.name, `이 요소를 생략했습니다: ${errorMessage(error)}`);
          }
        }
        applyStacking(node, childNodes);
      }
      applySizing(node, parsed, marginWrapper || parent, parsed.layout.absolute);
      if (marginWrapper) {
        // A fixed/Hug child plus padding can hug. Fill must retain measured size on that axis.
        if (parsed.size.widthMode === 'HUG' && node.layoutSizingHorizontal !== 'FILL') marginWrapper.layoutSizingHorizontal = 'HUG';
        if (parsed.size.heightMode === 'HUG' && node.layoutSizingVertical !== 'FILL') marginWrapper.layoutSizingVertical = 'HUG';
      }
      if (!isFixed(parsed) && !marginWrapper && parent && parentParsed && (parent.layoutMode === 'NONE' || parsed.layout.absolute)) placements.push({ node, parsed, parent, parentParsed });
      countNode(node);
      if (report.total % 25 === 0) {
        onProgress(report.total);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
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
    if (created.type !== 'FRAME') throw new Error('루트 Frame을 생성할 수 없습니다.');
    if (cancelled()) throw new Error('변환을 취소했습니다.');
    created.name = `Imported HTML${doc.options.debug && doc.root.source ? ` [${doc.root.source.selector}]` : ''}`;
    if (created.layoutMode !== 'NONE') created.layoutSizingHorizontal = 'FIXED';
    created.resizeWithoutConstraints(doc.options.viewport, clamp(created.height, 0.01));
    // Fixed layers belong to the viewport, outside DOM parents' clipping and document anchors.
    // Hoist the whole subtree before placing its descendants; keep fixed layers in z-index order.
    const fixed = fixedPlacements.filter(item => !item.node.removed).sort((a, b) => (a.parsed.layout.zIndex || 0) - (b.parsed.layout.zIndex || 0));
    for (const { node, parsed } of fixed) placeFixed(node, parsed, created);
    if (fixed.length && 'numberOfFixedChildren' in created) {
      try { created.numberOfFixedChildren = fixed.length; }
      catch (error) { warn('FIXED_SCROLL', created.name, `Figma 스크롤 고정을 적용하지 못했지만 Viewport 기준 좌표는 유지합니다: ${errorMessage(error)}`); }
    }
    // Sizing and reparenting can change node geometry. Apply browser-relative positions last,
    // from outer frames to descendants, after the root viewport size is final.
    for (const { node, parsed, parent, parentParsed } of placements.reverse()) if (!node.removed) place(node, parsed, parent, parentParsed);
    // Generate backgrounds after content sizing; absolute rectangles cannot affect Auto Layout/Hug.
    for (const { node, parsed, lines } of gridBackgrounds) if (!node.removed) createBackgroundGrid(node, parsed, lines);
    for (const { node, parsed, layers } of backgroundDiagnostics) if (!node.removed) debugBackground(node, parsed, layers);
    created.x = figma.viewport.center.x - created.width / 2;
    created.y = figma.viewport.center.y - created.height / 2;
    figma.currentPage.selection = [created];
    figma.viewport.scrollAndZoomIntoView([created]);
    // Count surviving layers; a partially failing subtree may have been removed after creation.
    const nodes: SceneNode[] = [created]; report.total = 0; report.text = 0; report.image = 0; report.autoLayout = 0;
    while (nodes.length) {
      const current = nodes.pop()!; report.total++;
      if (current.type === 'TEXT') report.text++;
      if (current.type === 'FRAME') report.frames++;
      if (current.type === 'RECTANGLE' && current.getPluginData('html-type') === 'image') report.image++;
      if (current.getPluginData('html-background-image') === 'true') report.image++;
      if (current.getPluginData('html-type') === 'svg') report.svg++;
      if (current.getPluginData('html-grid') === 'true') report.grid++;
      if (current.getPluginData('html-absolute') === 'true') report.absolute++;
      if (current.type === 'FRAME' && current.layoutMode !== 'NONE') report.autoLayout++;
      if ('children' in current) nodes.push(...current.children);
    }
    report.warningGroups = enrichWarnings(report.warnings, doc.root);
    report.durationMs = Date.now() - started;
    // Naming is a final presentation pass, after all geometry, styling, SVG and reporting work.
    applyLayerNames(namingAssignments, doc.options.debug === true);
    return { frame: created, report };
  } catch (error) { if (root && !root.removed) root.remove(); throw error; }
}

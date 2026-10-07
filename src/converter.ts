import { LIMITS, type Color, type ConversionReport, type ParsedDocument, type ParsedImage, type ParsedNode, type SizingMode } from './types';
import { clamp, errorMessage, isViewportDimension } from './utils';
import { enrichWarnings } from './report';

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
  const stack = [{ node: doc.root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > LIMITS.nodes || depth > LIMITS.depth) throw new Error('문서의 노드 수 또는 깊이 제한을 초과했습니다.');
    if (!node || !['FRAME', 'TEXT', 'IMAGE', 'SVG'].includes(node.type) || typeof node.name !== 'string' || typeof node.tagName !== 'string' || !Array.isArray(node.children) || !node.size || !node.layout || !node.style || !node.rect) throw new Error('잘못된 노드 데이터입니다.');
    if (node.svg !== undefined && (typeof node.svg !== 'string' || node.svg.length > LIMITS.fileBytes)) throw new Error('잘못된 SVG 데이터입니다.');
    if (node.type === 'TEXT' && (typeof node.text !== 'string' || node.text.length > 1000000)) throw new Error('잘못된 텍스트 데이터입니다.');
    if (!finite(node.size.width) || !finite(node.size.height) || node.size.width < 0 || node.size.height < 0 || !['FIXED', 'FILL', 'HUG'].includes(node.size.widthMode) || !['FIXED', 'FILL', 'HUG'].includes(node.size.heightMode)) throw new Error('잘못된 크기 데이터입니다.');
    for (const value of [node.size.minWidth, node.size.maxWidth, node.size.minHeight, node.size.maxHeight]) if (value !== undefined && value !== null && (!finite(value) || value < 0)) throw new Error('잘못된 최소/최대 크기입니다.');
    if (node.style.shadow && (!node.style.shadow.color || ![node.style.shadow.x, node.style.shadow.y, node.style.shadow.blur, node.style.shadow.spread].every(value => finite(value)))) throw new Error('잘못된 그림자 데이터입니다.');
    if (!['HORIZONTAL', 'VERTICAL', 'NONE'].includes(node.layout.direction) || !['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'].includes(node.layout.justify) || !['MIN', 'CENTER', 'MAX'].includes(node.layout.align) || !finite(node.layout.gap) || !finite(node.layout.order)) throw new Error('잘못된 레이아웃 데이터입니다.');
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
    node.fills = doc.options.styles && style.background ? [solid(style.background)] : [];
    node.strokes = [];
    if (!doc.options.styles) return;
    if (doc.options.images !== false && style.backgroundImage) {
      const paint = imagePaint(style.backgroundImage, parsed.name);
      if (paint) { node.fills = [paint, ...node.fills as Paint[]]; node.setPluginData('html-background-image', 'true'); }
    }
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
      node.textAutoResize = intrinsic ? 'WIDTH_AND_HEIGHT' : !doc.options.autoLayout ? 'NONE' : parsed.size.heightMode === 'HUG' ? 'HEIGHT' : 'NONE';
    }
    const mode = (requested: SizingMode, horizontal: boolean): SizingMode => {
      if (!doc.options.autoLayout) return 'FIXED';
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
        node.constraints = { horizontal: offsets.left !== 'auto' && offsets.right !== 'auto' ? 'STRETCH' : offsets.right !== 'auto' ? 'MAX' : 'MIN', vertical: offsets.top !== 'auto' && offsets.bottom !== 'auto' ? 'STRETCH' : offsets.bottom !== 'auto' ? 'MAX' : 'MIN' };
      }
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
      if (parsed.grid?.supported) node.setPluginData('html-grid', 'true');
      if (parsed.layout.absolute) node.setPluginData('html-absolute', 'true');
      node.resize(clamp(parsed.size.width, 0.01), clamp(parsed.size.height, 0.01));
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
      if (!marginWrapper && parent && parentParsed && (parent.layoutMode === 'NONE' || parsed.layout.absolute)) placements.push({ node, parsed, parent, parentParsed });
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
    // Sizing and reparenting can change node geometry. Apply browser-relative positions last,
    // from outer frames to descendants, after the root viewport size is final.
    for (const { node, parsed, parent, parentParsed } of placements.reverse()) if (!node.removed) place(node, parsed, parent, parentParsed);
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
    return { frame: created, report };
  } catch (error) { if (root && !root.removed) root.remove(); throw error; }
}

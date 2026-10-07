import { LIMITS, type Color, type ConversionReport, type ParsedDocument, type ParsedNode, type SizingMode } from './types';
import { clamp, errorMessage, isViewportDimension } from './utils';

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
    const key = `${requested.join(',')}|${weight}|${italic}`;
    if (!this.cache.has(key)) this.cache.set(key, this.find(requested, weight, italic));
    const selected = await this.cache.get(key)!;
    if (selected && !requested.some(name => name.toLowerCase() === selected.family.toLowerCase())) {
      this.warn('FONT_REPLACED', node.name, `${requested.join(', ')} → ${selected.family} ${selected.style}`);
    } else if (selected && (Math.abs(fontWeight(selected.style) - weight) >= 100 || /italic|oblique/i.test(selected.style) !== italic)) {
      this.warn('FONT_STYLE_REPLACED', node.name, `사용 가능한 ${selected.family} ${selected.style}로 폰트 스타일을 대체했습니다.`);
    }
    return selected;
  }
  private async find(requested: string[], weight: number, italic: boolean): Promise<FontName | null> {
    const families = [...new Set([...requested, 'Pretendard', 'Inter', 'Arial', 'Roboto'])];
    for (const family of families) {
      const candidates = this.available.filter(font => font.family.toLowerCase() === family.toLowerCase());
      candidates.sort((a, b) => this.score(a, weight, italic) - this.score(b, weight, italic));
      if (!this.available.length) candidates.push({ family, style: weight >= 600 ? (italic ? 'Bold Italic' : 'Bold') : (italic ? 'Italic' : 'Regular') }, { family, style: 'Regular' });
      for (const font of candidates) {
        const key = `${font.family}|${font.style}`;
        if (!this.loaded.has(key)) this.loaded.set(key, figma.loadFontAsync(font).then(() => true, () => false));
        if (await this.loaded.get(key)) return font;
      }
    }
    // A local font list may not include the suggested families. Use any genuinely loadable font.
    for (const font of [...this.available].sort((a, b) => this.score(a, weight, italic) - this.score(b, weight, italic))) {
      const key = `${font.family}|${font.style}`;
      if (!this.loaded.has(key)) this.loaded.set(key, figma.loadFontAsync(font).then(() => true, () => false));
      if (await this.loaded.get(key)) return font;
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
  for (const warning of doc.warnings) if (!warning || typeof warning.code !== 'string' || typeof warning.node !== 'string' || typeof warning.message !== 'string') throw new Error('잘못된 경고 데이터입니다.');
  const finite = (value: unknown, max: number = LIMITS.dimension) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max;
  const stack = [{ node: doc.root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > LIMITS.nodes || depth > LIMITS.depth) throw new Error('문서의 노드 수 또는 깊이 제한을 초과했습니다.');
    if (!node || !['FRAME', 'TEXT', 'IMAGE'].includes(node.type) || typeof node.name !== 'string' || typeof node.tagName !== 'string' || !Array.isArray(node.children) || !node.size || !node.layout || !node.style || !node.rect) throw new Error('잘못된 노드 데이터입니다.');
    if (node.type === 'TEXT' && (typeof node.text !== 'string' || node.text.length > 1000000)) throw new Error('잘못된 텍스트 데이터입니다.');
    if (!finite(node.size.width) || !finite(node.size.height) || node.size.width < 0 || node.size.height < 0 || !['FIXED', 'FILL', 'HUG'].includes(node.size.widthMode) || !['FIXED', 'FILL', 'HUG'].includes(node.size.heightMode)) throw new Error('잘못된 크기 데이터입니다.');
    if (!['HORIZONTAL', 'VERTICAL', 'NONE'].includes(node.layout.direction) || !['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'].includes(node.layout.justify) || !['MIN', 'CENTER', 'MAX'].includes(node.layout.align) || !finite(node.layout.gap) || !finite(node.layout.order)) throw new Error('잘못된 레이아웃 데이터입니다.');
    for (const inset of [node.layout.padding, node.layout.margin, node.style.borderWidths]) if (!inset || ![inset.top, inset.right, inset.bottom, inset.left].every(v => finite(v))) throw new Error('잘못된 여백 데이터입니다.');
    if (![node.rect.x, node.rect.y, node.rect.width, node.rect.height, node.style.opacity, node.style.fontSize, node.style.fontWeight, node.style.letterSpacing, ...node.style.radii].every(v => finite(v))) throw new Error('잘못된 스타일 치수입니다.');
    for (const color of [node.style.background, node.style.color, ...node.style.borderColors]) if (color && ![color.r, color.g, color.b, color.a].every(v => finite(v, 1) && v >= 0)) throw new Error('잘못된 색상입니다.');
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
  const report: ConversionReport = { total: 0, autoLayout: 0, text: 0, image: 0, warnings: [...doc.warnings] };
  const seen = new Set(report.warnings.map(w => `${w.code}|${w.node}|${w.message}`));
  const warn = (code: string, node: string, message: string) => {
    const key = `${code}|${node}|${message}`;
    if (!seen.has(key) && report.warnings.length < 1000) { report.warnings.push({ code, node, message }); seen.add(key); }
  };
  const fonts = new FontResolver(warn);
  await fonts.initialize();
  const imageHashes = new Map<string, string>();
  let root: FrameNode | undefined;

  function applyBoxStyle(node: FrameNode | RectangleNode, parsed: ParsedNode): void {
    const style = parsed.style;
    node.fills = doc.options.styles && style.background ? [solid(style.background)] : [];
    node.strokes = [];
    if (!doc.options.styles) return;
    node.opacity = clamp(style.opacity, 0, 1);
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
    const canHug = node.type === 'TEXT' || (node.type === 'FRAME' && node.layoutMode !== 'NONE');
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
    // Only Auto Layout frames, their flow children, and text support these API properties.
    if (canHug || autoParent) {
      node.layoutSizingHorizontal = mode(parsed.size.widthMode, true);
      node.layoutSizingVertical = mode(parsed.size.heightMode, false);
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
          // Fixed-width / Fill text wraps and hugs height. Explicit height preserves clipping boxes.
          text.textAutoResize = !doc.options.autoLayout ? 'NONE' : parsed.size.widthMode === 'HUG' && !parsed.layout.absolute ? 'WIDTH_AND_HEIGHT' : parsed.size.heightMode === 'HUG' ? 'HEIGHT' : 'NONE';
        }
      } else if (parsed.type === 'IMAGE') {
        const image = figma.createRectangle(); node = image;
        image.setPluginData('html-type', 'image');
        applyBoxStyle(image, parsed);
        const key = parsed.image?.key;
        try {
          if (!key || !doc.assets[key]) throw new Error('이미지 데이터가 없습니다.');
          if (!imageHashes.has(key)) imageHashes.set(key, figma.createImage(new Uint8Array(doc.assets[key]!)).hash);
          const scaleMode: ImagePaint['scaleMode'] = parsed.image?.fit === 'contain' ? 'FIT' : 'FILL';
          if (parsed.image?.fit === 'fill') warn('IMAGE_STRETCH', parsed.name, 'object-fit:fill은 비율을 유지하는 Image Fill로 단순화합니다.');
          image.fills = [{ type: 'IMAGE', imageHash: imageHashes.get(key)!, scaleMode }];
        } catch (error) {
          image.fills = [solid({ r: 0.89, g: 0.91, b: 0.94, a: 1 })];
          warn('IMAGE_PLACEHOLDER', parsed.name, `Image Fill을 placeholder로 대체했습니다: ${errorMessage(error)}`);
        }
        report.image++;
      } else {
        const frame = figma.createFrame(); node = frame;
        if (!parent) root = frame;
        applyBoxStyle(frame, parsed); configureLayout(frame, parsed);
      }
      node.name = parsed.name;
      node.resize(clamp(parsed.size.width, 0.01), clamp(parsed.size.height, 0.01));
      // CSS margins have no native Figma equivalent. Add an unpainted padding wrapper in flex flow.
      const margin = parsed.layout.margin;
      const autoParent = !!parent && parent.layoutMode !== 'NONE' && !parsed.layout.absolute;
      if (autoParent && Object.values(margin).some(v => v !== 0)) {
        if (Object.values(margin).some(v => v < 0)) warn('NEGATIVE_MARGIN', parsed.name, '음수 margin은 0으로 단순화했습니다.');
        const top = Math.max(0, margin.top), right = Math.max(0, margin.right), bottom = Math.max(0, margin.bottom), left = Math.max(0, margin.left);
        marginWrapper = figma.createFrame(); marginWrapper.name = `${parsed.name} / margin`; marginWrapper.fills = []; marginWrapper.clipsContent = false;
        marginWrapper.layoutMode = 'VERTICAL'; marginWrapper.primaryAxisSizingMode = 'FIXED'; marginWrapper.counterAxisSizingMode = 'FIXED';
        marginWrapper.paddingTop = top; marginWrapper.paddingRight = right; marginWrapper.paddingBottom = bottom; marginWrapper.paddingLeft = left;
        marginWrapper.resize(clamp(parsed.size.width + left + right, 0.01), clamp(parsed.size.height + top + bottom, 0.01));
        parent.appendChild(marginWrapper); marginWrapper.appendChild(node);
        marginWrapper.layoutSizingHorizontal = parsed.size.widthMode === 'FILL' ? 'FILL' : 'FIXED';
        marginWrapper.layoutSizingVertical = parsed.size.heightMode === 'FILL' ? 'FILL' : 'FIXED';
        countNode(marginWrapper);
      } else if (parent) parent.appendChild(node);
      place(node, parsed, marginWrapper ? undefined : parent, parentParsed);
      if (node.type === 'FRAME') {
        let children = [...parsed.children];
        if (node.layoutMode !== 'NONE') {
          children.sort((a, b) => a.layout.order - b.layout.order);
          if (parsed.layout.reverse) children.reverse();
        }
        for (const child of children) {
          try { await create(child, node, parsed); }
          catch (error) {
            if (cancelled()) throw error;
            warn('NODE_FAILED', child.name, `이 요소를 생략했습니다: ${errorMessage(error)}`);
          }
        }
      }
      applySizing(node, parsed, marginWrapper || parent, parsed.layout.absolute);
      if (marginWrapper) {
        // A fixed/Hug child plus padding can hug. Fill must retain measured size on that axis.
        if (parsed.size.widthMode === 'HUG' && node.layoutSizingHorizontal !== 'FILL') marginWrapper.layoutSizingHorizontal = 'HUG';
        if (parsed.size.heightMode === 'HUG' && node.layoutSizingVertical !== 'FILL') marginWrapper.layoutSizingVertical = 'HUG';
      }
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
    created.name = 'Imported HTML';
    if (created.layoutMode !== 'NONE') created.layoutSizingHorizontal = 'FIXED';
    created.resize(doc.options.viewport, clamp(created.height, 0.01));
    created.x = figma.viewport.center.x - created.width / 2;
    created.y = figma.viewport.center.y - created.height / 2;
    figma.currentPage.selection = [created];
    figma.viewport.scrollAndZoomIntoView([created]);
    // Count surviving layers; a partially failing subtree may have been removed after creation.
    const nodes: SceneNode[] = [created]; report.total = 0; report.text = 0; report.image = 0; report.autoLayout = 0;
    while (nodes.length) {
      const current = nodes.pop()!; report.total++;
      if (current.type === 'TEXT') report.text++;
      if (current.type === 'RECTANGLE' && current.getPluginData('html-type') === 'image') report.image++;
      if (current.type === 'FRAME' && current.layoutMode !== 'NONE') report.autoLayout++;
      if ('children' in current) nodes.push(...current.children);
    }
    return { frame: created, report };
  } catch (error) { if (root && !root.removed) root.remove(); throw error; }
}

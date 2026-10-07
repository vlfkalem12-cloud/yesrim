import { LIMITS, type Bounds, type ConversionWarning, type ImportOptions, type ParsedDocument, type ParsedLayout, type ParsedNode, type ParsedSize, type ParsedStyle, type SizingMode } from './types';
import { clamp, errorMessage, isViewportDimension, number, parseColor, readInsets, withTimeout } from './utils';

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'label', 'strong', 'small', 'a', 'em', 'b', 'i', 'li', 'pre', 'code']);
const OMIT_TAGS = new Set(['head', 'style', 'script', 'link', 'meta', 'title', 'noscript', 'template', 'br']);
const UNSUPPORTED_TAGS = new Set(['canvas', 'video', 'audio', 'iframe', 'object', 'embed', 'svg']);
const zero = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
const allowedAsset = (url: string) => /^https:\/\//i.test(url) || /^data:image\//i.test(url);
const layerName = (el: Element) => el.id || el.getAttribute('class')?.trim() || el.tagName.toLowerCase();

function sanitizeHTML(html: string, warnings: ConversionWarning[]): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const warn = (code: string, node: string, message: string) => warnings.push({ code, node, message });
  const scripts = doc.querySelectorAll('script');
  if (scripts.length) warn('SCRIPT_IGNORED', 'document', `${scripts.length}개의 스크립트는 실행하지 않습니다.`);
  doc.querySelectorAll('script, base, meta, object, embed, iframe, noscript').forEach(el => {
    if (['iframe', 'object', 'embed'].includes(el.localName)) warn('UNSUPPORTED_ELEMENT', layerName(el), `${el.localName} 요소는 제외했습니다.`);
    el.remove();
  });
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || ['srcdoc', 'autofocus', 'action', 'formaction', 'target', 'ping', 'contenteditable'].includes(attr.name)) el.removeAttribute(attr.name);
    }
    if (el.localName === 'a') el.removeAttribute('href');
    if (el.localName === 'link') {
      const href = el.getAttribute('href') || '';
      if (el.getAttribute('rel') !== 'stylesheet' || !/^https:\/\//i.test(href)) {
        if (el.getAttribute('rel') === 'stylesheet') warn('RELATIVE_ASSET', layerName(el), `CSS 경로 ${href}를 읽을 수 없습니다. 인라인 CSS 또는 HTTPS URL을 사용하세요.`);
        el.remove();
      }
    }
    if (el.localName === 'img') {
      el.removeAttribute('srcset');
      el.removeAttribute('loading');
      const src = el.getAttribute('src') || '';
      if (!allowedAsset(src)) {
        warn('IMAGE_SOURCE', layerName(el), '상대 경로 또는 HTTP 이미지는 업로드한 HTML만으로 불러올 수 없습니다.');
        el.setAttribute('data-original-src', src);
        el.removeAttribute('src');
      } else if (/^https:/i.test(src)) el.setAttribute('crossorigin', 'anonymous');
    }
  }
  // An inert parser plus a scripts-disabled sandbox protects both the UI and the uploaded document.
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; style-src 'unsafe-inline' https:; img-src data: https:; font-src data: https:; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
  doc.head.prepend(csp);
  const stable = doc.createElement('style');
  stable.textContent = '* { animation: none !important; transition: none !important; caret-color: transparent !important; }';
  doc.head.append(stable);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}

export interface RenderedHTML { iframe: HTMLIFrameElement; document: Document; warnings: ConversionWarning[]; dispose: () => void }
export async function renderHTML(html: string, viewport: number, viewportHeight: number, host: HTMLElement): Promise<RenderedHTML> {
  if (!isViewportDimension(viewport) || !isViewportDimension(viewportHeight)) throw new Error('Viewport 너비와 높이는 1~10,000px의 정수로 입력하세요.');
  const warnings: ConversionWarning[] = [];
  const iframe = document.createElement('iframe');
  iframe.title = 'HTML 분석 영역';
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('aria-hidden', 'true');
  // Do not use display:none: the browser must lay out the document at its selected viewport width.
  Object.assign(iframe.style, { position: 'absolute', left: '-120000px', top: '0', width: `${viewport}px`, height: `${viewportHeight}px`, border: '0', pointerEvents: 'none' });
  iframe.srcdoc = sanitizeHTML(html, warnings);
  const loaded = new Promise<void>(resolve => iframe.addEventListener('load', () => resolve(), { once: true }));
  host.append(iframe);
  try {
    await withTimeout(loaded, LIMITS.loadMs, '외부 리소스 로딩 시간 초과');
  } catch {
    warnings.push({ code: 'RESOURCE_TIMEOUT', node: 'document', message: '일부 외부 리소스가 늦어 현재 렌더링된 스타일로 변환합니다.' });
  }
  const doc = iframe.contentDocument;
  if (!doc?.body) { iframe.remove(); throw new Error('HTML 문서를 렌더링할 수 없습니다.'); }
  try { await withTimeout(doc.fonts.ready, LIMITS.loadMs, '폰트 로딩 시간 초과'); }
  catch { warnings.push({ code: 'WEB_FONT_TIMEOUT', node: 'document', message: '웹 폰트 대신 브라우저 대체 폰트로 치수를 측정했습니다.' }); }
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    if (!link.sheet) warnings.push({ code: 'STYLESHEET_LOAD', node: 'document', message: `외부 CSS를 불러오지 못했습니다: ${link.getAttribute('href')}` });
  }
  return { iframe, document: doc, warnings, dispose: () => iframe.remove() };
}

/** Typed OM keeps percentages and auto keywords that getComputedStyle() resolves to pixels. */
function authoredDimension(el: Element, property: 'width' | 'height', style: CSSStyleDeclaration): string {
  const typed = el as Element & { computedStyleMap?: () => { get: (key: string) => { toString(): string } | undefined } };
  try { const value = typed.computedStyleMap?.().get(property); if (value) return value.toString(); } catch { /* Older browsers use the cascade fallback below. */ }
  const inline = (el as HTMLElement).style?.getPropertyValue(property);
  if (inline) return inline;
  // Read local rules if Typed OM is unavailable. Cross-origin stylesheets may be opaque.
  let declared = '';
  const inspect = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if ('selectorText' in rule && 'style' in rule) {
        const css = rule as CSSStyleRule;
        try { if (el.matches(css.selectorText) && css.style.getPropertyValue(property)) declared = css.style.getPropertyValue(property); } catch { /* unsupported selector */ }
      } else if ('cssRules' in rule) {
        const group = rule as CSSGroupingRule;
        if ('conditionText' in rule && rule.type === 4 && !el.ownerDocument.defaultView?.matchMedia((rule as CSSMediaRule).conditionText).matches) continue;
        inspect(group.cssRules);
      }
    }
  };
  for (const sheet of Array.from(el.ownerDocument.styleSheets)) { try { inspect(sheet.cssRules); } catch { /* CORS */ } }
  return declared || 'auto';
}

function inferSizing(el: Element, style: CSSStyleDeclaration, parentStyle: CSSStyleDeclaration | null, width: number, height: number): ParsedSize {
  const authoredWidth = authoredDimension(el, 'width', style);
  const authoredHeight = authoredDimension(el, 'height', style);
  const parentFlex = !!parentStyle && ['flex', 'inline-flex'].includes(parentStyle.display) && parentStyle.flexWrap === 'nowrap';
  const parentColumn = parentStyle?.flexDirection.startsWith('column');
  const align = style.alignSelf === 'auto' ? parentStyle?.alignItems : style.alignSelf;
  const auto = (v: string) => v === 'auto' || v.includes('fit-content') || v.includes('max-content') || v.includes('min-content');
  const mode = (dimension: 'width' | 'height', value: string): SizingMode => {
    if (value === '100%' && parentFlex) return 'FILL';
    if (parentFlex && number(style.flexGrow) > 0 && (dimension === 'width' ? !parentColumn : parentColumn)) return 'FILL';
    if (auto(value)) {
      if (parentFlex && (dimension === 'width' ? parentColumn : !parentColumn) && (align === 'stretch' || align === 'normal')) return 'FILL';
      // Block elements with auto width fill their containing block, even without Auto Layout.
      if (dimension === 'width' && !parentFlex && !['inline', 'inline-block', 'inline-flex'].includes(style.display)) return 'FIXED';
      return 'HUG';
    }
    return 'FIXED';
  };
  return { width, height, widthMode: mode('width', authoredWidth), heightMode: mode('height', authoredHeight), authoredWidth, authoredHeight };
}

function readStyle(style: CSSStyleDeclaration): ParsedStyle {
  const radius = (key: string) => number(style.getPropertyValue(key));
  return {
    background: parseColor(style.backgroundColor), color: parseColor(style.color), borderWidths: readInsets(style, 'border'),
    borderColors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor].map(parseColor) as ParsedStyle['borderColors'],
    radii: [radius('border-top-left-radius'), radius('border-top-right-radius'), radius('border-bottom-right-radius'), radius('border-bottom-left-radius')],
    opacity: clamp(number(style.opacity, 1), 0, 1), fontFamily: style.fontFamily, fontSize: clamp(number(style.fontSize, 16), 1, 1000),
    fontWeight: number(style.fontWeight, 400), fontStyle: style.fontStyle, lineHeight: style.lineHeight === 'normal' ? null : number(style.lineHeight),
    letterSpacing: number(style.letterSpacing), textAlign: style.textAlign, textDecoration: style.textDecorationLine, whiteSpace: style.whiteSpace,
    clipsContent: ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY)
  };
}

function readLayout(style: CSSStyleDeclaration): ParsedLayout {
  const flex = ['flex', 'inline-flex'].includes(style.display);
  const column = style.flexDirection.startsWith('column');
  const reverse = style.flexDirection.endsWith('reverse');
  const align = (value: string): 'MIN' | 'CENTER' | 'MAX' => value.includes('end') ? 'MAX' : value.includes('center') ? 'CENTER' : 'MIN';
  let justify: ParsedLayout['justify'] = style.justifyContent === 'space-between' ? 'SPACE_BETWEEN' : align(style.justifyContent);
  if (reverse && justify !== 'SPACE_BETWEEN' && justify !== 'CENTER') justify = justify === 'MIN' ? 'MAX' : 'MIN';
  return {
    display: style.display, direction: flex ? (column ? 'VERTICAL' : 'HORIZONTAL') : 'NONE', reverse, justify, align: align(style.alignItems),
    stretch: style.alignItems === 'stretch' || style.alignItems === 'normal', gap: Math.max(0, number(column ? style.rowGap : style.columnGap)),
    padding: readInsets(style, 'padding'), margin: readInsets(style, 'margin'), position: style.position,
    absolute: style.position === 'absolute' || style.position === 'fixed', grow: number(style.flexGrow), alignSelf: style.alignSelf,
    order: number(style.order), wrap: flex && style.flexWrap !== 'nowrap'
  };
}

export function parseGrid(node: ParsedNode, warn: (code: string, name: string, message: string) => void): void {
  node.layout.direction = 'NONE';
  node.size.widthMode = 'FIXED';
  node.size.heightMode = 'FIXED';
  warn('CSS_GRID', node.name, 'CSS Grid를 고정 위치 Frame으로 변환했습니다.');
}

export async function parseRenderedHTML(rendered: RenderedHTML, options: ImportOptions): Promise<ParsedDocument> {
  const doc = rendered.document;
  const view = doc.defaultView!;
  const warnings = [...rendered.warnings];
  const assets: Record<string, number[]> = {};
  const warn = (code: string, node: string, message: string) => { if (warnings.length < 500) warnings.push({ code, node, message }); };
  let count = 0;
  const bounds = (rect: DOMRect): Bounds => ({ x: rect.left, y: rect.top, width: clamp(rect.width), height: clamp(rect.height) });
  const hasBlockChildren = (el: Element) => [...el.children].some(child => !['inline', 'inline-block', 'contents', 'none'].includes(view.getComputedStyle(child).display) || ['img', 'svg'].includes(child.localName));
  const text = (el: HTMLElement) => el.innerText || el.textContent || '';
  function parse(el: Element, depth: number): ParsedNode[] {
    if (OMIT_TAGS.has(el.localName)) return [];
    if (count >= LIMITS.nodes || depth > LIMITS.depth) { warn('TREE_LIMIT', layerName(el), '노드 수 또는 중첩 깊이 제한으로 일부 요소를 생략했습니다.'); return []; }
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return [];
    if (style.display === 'contents') {
      warn('DISPLAY_CONTENTS', layerName(el), 'display:contents 요소의 자식들을 부모에 배치했습니다.');
      return parseChildren(el, depth);
    }
    const rect = bounds(el.getBoundingClientRect());
    if (rect.width === 0 && rect.height === 0 && !el.children.length) return [];
    const name = layerName(el);
    const isText = TEXT_TAGS.has(el.localName) && !hasBlockChildren(el);
    const node: ParsedNode = {
      type: el.localName === 'img' ? 'IMAGE' : isText ? 'TEXT' : 'FRAME', tagName: el.localName, name, rect,
      layout: readLayout(style), size: inferSizing(el, style, el.parentElement ? view.getComputedStyle(el.parentElement) : null, rect.width, rect.height),
      style: readStyle(style), children: []
    };
    count++;
    if (node.layout.absolute) warn('ABSOLUTE_ELEMENT', name, '절대 위치를 유지하고 Auto Layout 흐름에서 분리했습니다.');
    if (node.layout.wrap) { node.layout.direction = 'NONE'; node.size.heightMode = 'FIXED'; warn('FLEX_WRAP', name, '여러 줄 Flexbox는 측정된 고정 위치로 유지했습니다.'); }
    if (style.display.includes('grid')) parseGrid(node, warn);
    if (style.transform !== 'none') warn('TRANSFORM', name, 'CSS transform은 측정된 경계 상자로 단순화했습니다.');
    if (style.cssFloat !== 'none') warn('FLOAT', name, 'float는 측정된 위치만 유지합니다.');
    if (style.backgroundImage !== 'none') warn('BACKGROUND_IMAGE', name, '배경 이미지·그라데이션은 MVP에서 색상으로 단순화합니다.');
    if (style.boxShadow !== 'none') warn('BOX_SHADOW', name, '그림자는 MVP에서 생략합니다.');
    if (['space-around', 'space-evenly'].includes(style.justifyContent)) warn('JUSTIFY_CONTENT', name, `${style.justifyContent}를 시작 정렬로 단순화합니다.`);
    if (style.alignItems.includes('baseline')) warn('BASELINE', name, 'baseline 정렬을 시작 정렬로 단순화합니다.');
    for (const pseudo of ['::before', '::after']) {
      const content = view.getComputedStyle(el, pseudo).content;
      if (content && !['none', 'normal', '""'].includes(content)) warn('PSEUDO_ELEMENT', name, `${pseudo} 생성 콘텐츠는 생략했습니다.`);
    }
    if (node.type === 'TEXT') {
      node.text = text(el as HTMLElement);
      if (style.textTransform === 'uppercase') node.text = node.text.toUpperCase();
      if (style.textTransform === 'lowercase') node.text = node.text.toLowerCase();
      if (el.children.length) warn('INLINE_TEXT', name, '여러 inline 텍스트 스타일을 부모의 스타일로 통합했습니다.');
      if ((node.style.background?.a || Object.values(node.style.borderWidths).some(v => v > 0) || Object.values(node.layout.padding).some(v => v > 0)) && count < LIMITS.nodes && depth < LIMITS.depth) {
        // Keep decorated text editable, with a frame carrying its box styling.
        node.type = 'FRAME';
        const range = doc.createRange(); range.selectNodeContents(el);
        const child: ParsedNode = { ...node, type: 'TEXT', name: `${name} / text`, rect: bounds(range.getBoundingClientRect()),
          style: { ...node.style, opacity: 1, background: null, borderWidths: zero(), radii: [0, 0, 0, 0] },
          layout: { ...node.layout, direction: 'NONE', padding: zero(), margin: zero(), absolute: false }, children: [] };
        child.size = { ...node.size, width: child.rect.width, height: child.rect.height, widthMode: 'FIXED', heightMode: 'HUG' };
        node.children = [child]; node.text = undefined; count++;
      }
    } else if (node.type === 'IMAGE') {
      const img = el as HTMLImageElement;
      node.image = { key: '', src: img.getAttribute('src') || img.getAttribute('data-original-src') || '', alt: img.alt, fit: style.objectFit };
    } else if (UNSUPPORTED_TAGS.has(el.localName) || el.localName.includes('-')) {
      warn('UNSUPPORTED_ELEMENT', name, `${el.localName}은 편집 가능한 빈 Frame으로 대체했습니다.`);
    } else {
      node.children = parseChildren(el, depth);
    }
    if (!options.autoLayout) node.layout.direction = 'NONE';
    return [node];
  }
  function parseChildren(el: Element, depth: number): ParsedNode[] {
    if (depth >= LIMITS.depth) { warn('TREE_LIMIT', layerName(el), '중첩 깊이 제한으로 자식 요소를 생략했습니다.'); return []; }
    const children: ParsedNode[] = [];
    for (const child of [...el.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) children.push(...parse(child as Element, depth + 1));
      else if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim() && count < LIMITS.nodes) {
        const range = doc.createRange(); range.selectNode(child);
        const rect = bounds(range.getBoundingClientRect());
        const style = view.getComputedStyle(el);
        const preserve = ['pre', 'pre-wrap', 'break-spaces'].includes(style.whiteSpace);
        const value = preserve ? child.textContent : child.textContent.replace(/\s+/g, ' ').trim();
        if (!rect.width && !rect.height) continue;
        children.push({ type: 'TEXT', tagName: '#text', name: `${layerName(el)} / text`, text: value, rect,
          size: { width: rect.width, height: rect.height, widthMode: 'FIXED', heightMode: 'HUG', authoredWidth: 'auto', authoredHeight: 'auto' },
          layout: { ...readLayout(style), display: 'inline', direction: 'NONE', padding: zero(), margin: zero(), absolute: false, grow: 0, order: 0, alignSelf: 'auto', wrap: false },
          style: { ...readStyle(style), background: null, opacity: 1, borderWidths: zero(), radii: [0, 0, 0, 0] }, children: [] });
        count++;
      }
    }
    return children;
  }
  const body = parse(doc.body, 0)[0];
  if (!body) throw new Error('변환할 수 있는 표시 요소가 없습니다.');
  const bodyStyle = view.getComputedStyle(doc.body);
  // A sole undecorated body wrapper may be collapsed into the imported viewport frame.
  const collapse = body.children.length === 1 && body.children[0]!.type === 'FRAME' && !body.children[0]!.layout.absolute &&
    Object.values(body.children[0]!.layout.margin).every(v => v === 0) && bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)' &&
    bodyStyle.display === 'block' && Object.values(body.layout.padding).every(v => v === 0) && Object.values(body.layout.margin).every(v => v === 0) &&
    Object.values(body.style.borderWidths).every(v => v === 0) && body.style.opacity === 1;
  const root = collapse ? body.children[0]! : body;
  if (!collapse) {
    // The imported viewport starts at document (0,0); CSS body's outside margins still occupy space.
    root.rect.x = 0; root.rect.y = 0;
    if (root.layout.direction !== 'NONE') {
      root.layout.padding = {
        top: root.layout.padding.top + Math.max(0, root.layout.margin.top), right: root.layout.padding.right + Math.max(0, root.layout.margin.right),
        bottom: root.layout.padding.bottom + Math.max(0, root.layout.margin.bottom), left: root.layout.padding.left + Math.max(0, root.layout.margin.left)
      };
    }
  }
  root.name = 'Imported HTML';
  root.layout.absolute = false;
  root.layout.margin = zero();
  root.size.width = options.viewport;
  root.size.widthMode = 'FIXED';
  const descendants = [root];
  let contentBottom = root.rect.y + root.rect.height;
  while (descendants.length) {
    const current = descendants.pop()!;
    contentBottom = Math.max(contentBottom, current.rect.y + current.rect.height);
    descendants.push(...current.children);
  }
  root.size.height = clamp(Math.max(root.size.height, contentBottom - root.rect.y, doc.body.scrollHeight, doc.documentElement.scrollHeight > options.viewportHeight ? doc.documentElement.scrollHeight : 0), 1);
  // Auto Layout roots hug content, fixed-position roots retain measured document height.
  root.size.heightMode = options.autoLayout && root.layout.direction !== 'NONE' ? 'HUG' : 'FIXED';
  if (root.children.length && root.children.every(child => child.layout.absolute)) root.size.heightMode = 'FIXED';
  if (root.rect.width > options.viewport + 1) warn('VIEWPORT_OVERFLOW', 'Imported HTML', '콘텐츠가 선택한 viewport보다 넓습니다. 루트 폭은 viewport로 고정하고 자식 치수는 유지합니다.');
  if (bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)') {
    const htmlBackground = parseColor(view.getComputedStyle(doc.documentElement).backgroundColor);
    if (htmlBackground && !root.style.background?.a) root.style.background = htmlBackground;
  }
  await collectImages(root, doc, assets, warn);
  return { version: 1, root, options, assets, warnings };
}

async function collectImages(root: ParsedNode, doc: Document, assets: Record<string, number[]>, warn: (code: string, node: string, message: string) => void): Promise<void> {
  const stack = [root];
  const cache = new Map<string, string>();
  let totalBytes = 0;
  while (stack.length) {
    const node = stack.pop()!; stack.push(...node.children);
    if (!node.image) continue;
    const src = node.image.src;
    if (cache.has(src)) { node.image.key = cache.get(src)!; continue; }
    try {
      if (!allowedAsset(src)) throw new Error('HTTPS 또는 data:image URL이 필요합니다.');
      const img = [...doc.images].find(image => image.getAttribute('src') === src);
      if (!img) throw new Error('이미지 요소를 찾을 수 없습니다.');
      await withTimeout(img.decode(), LIMITS.loadMs, '이미지 로딩 시간 초과');
      if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 16000000) throw new Error('이미지 치수가 없거나 16MP 제한을 초과했습니다.');
      const canvas = doc.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('이미지를 읽을 수 없습니다.');
      context.drawImage(img, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('이미지 변환 실패')), 'image/png'));
      if (blob.size > LIMITS.imageBytes || totalBytes + blob.size > LIMITS.assetBytes) throw new Error('이미지 데이터 용량 제한을 초과했습니다.');
      totalBytes += blob.size;
      const key = `image-${cache.size + 1}`;
      assets[key] = [...new Uint8Array(await blob.arrayBuffer())];
      cache.set(src, key); node.image.key = key;
    } catch (error) {
      cache.set(src, '');
      warn('IMAGE_LOAD', node.name, `${node.image.alt || '이미지'}를 placeholder로 대체합니다: ${errorMessage(error)}`);
    }
  }
}

export async function parseHTML(html: string, options: ImportOptions, host: HTMLElement): Promise<ParsedDocument> {
  const rendered = await renderHTML(html, options.viewport, options.viewportHeight, host);
  try { return await parseRenderedHTML(rendered, options); }
  finally { rendered.dispose(); }
}

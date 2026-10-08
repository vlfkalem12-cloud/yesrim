import { IMPORT_DEFAULTS, LIMITS, type Bounds, type ConversionWarning, type ImportOptions, type LocalAssets, type ParsedDocument, type ParsedLayout, type ParsedNode, type ParsedStyle } from './types';
import { clamp, errorMessage, isViewportDimension, number, parseColor, parseShadow, readInsets, splitCSSList, withTimeout } from './utils';
import { authoredDimension, inferSizing, inferTextWidth, isSingleTextLine } from './sizing';
import { buildGridRows, parseGrid } from './grid';
import { optimizeEmptyWrappers } from './optimizer';
import { serializeSVG } from './svg';
import { collectCSSVariableNames, readCSSVariables } from './css-variables';
import { allowedAsset, collectImages, resolveLocalAsset } from './assets';
import { measureFormText, readFormContent } from './form-controls';
import { parseLinearGradient } from './gradients';
import { isAccessibilityHidden } from './dom-visibility';
import { configureInlineRow, hasInlineBoxStyle, needsInlineChildren } from './inline-layout';

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'label', 'strong', 'small', 'a', 'em', 'b', 'i', 'li', 'pre', 'code']);
const OMIT_TAGS = new Set(['head', 'style', 'script', 'link', 'meta', 'title', 'noscript', 'template', 'br']);
const UNSUPPORTED_TAGS = new Set(['canvas', 'video', 'audio', 'iframe', 'object', 'embed']);
const zero = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
const layerName = (el: Element) => el.id || el.getAttribute('class')?.trim().split(/\s+/)[0] || el.tagName.toLowerCase();
const selector = (el: Element) => `${el.localName}${el.id ? `#${el.id}` : ''}${[...el.classList].map(name => `.${name}`).join('')}`;

function sanitizeHTML(html: string, warnings: ConversionWarning[], localAssets: LocalAssets): string {
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
    const resolveCSSAssets = (css: string) => css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (original: string, _quote: string, url: string) => {
      const resolved = resolveLocalAsset(url, localAssets);
      return resolved ? `url("${resolved}")` : original;
    });
    if (el.localName === 'style') el.textContent = resolveCSSAssets(el.textContent || '');
    if (el.hasAttribute('style')) el.setAttribute('style', resolveCSSAssets(el.getAttribute('style')!));
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
      const originalSrc = el.getAttribute('src') || '';
      const src = resolveLocalAsset(originalSrc, localAssets) || originalSrc;
      if (src !== originalSrc) { el.setAttribute('src', src); el.setAttribute('data-original-src', originalSrc); }
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
export async function renderHTML(html: string, viewport: number, viewportHeight: number, host: HTMLElement, localAssets: LocalAssets = {}): Promise<RenderedHTML> {
  if (!isViewportDimension(viewport) || !isViewportDimension(viewportHeight)) throw new Error('Viewport 너비와 높이는 1~10,000px의 정수로 입력하세요.');
  const warnings: ConversionWarning[] = [];
  const iframe = document.createElement('iframe');
  iframe.title = 'HTML 분석 영역';
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('aria-hidden', 'true');
  // Do not use display:none: the browser must lay out the document at its selected viewport width.
  Object.assign(iframe.style, { position: 'absolute', left: '-120000px', top: '0', width: `${viewport}px`, height: `${viewportHeight}px`, border: '0', pointerEvents: 'none' });
  iframe.srcdoc = sanitizeHTML(html, warnings, localAssets);
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

function readStyle(style: CSSStyleDeclaration): ParsedStyle {
  const radius = (key: string) => number(style.getPropertyValue(key));
  return {
    background: parseColor(style.backgroundColor), color: parseColor(style.color), borderWidths: readInsets(style, 'border'),
    borderColors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor].map(parseColor) as ParsedStyle['borderColors'],
    radii: [radius('border-top-left-radius'), radius('border-top-right-radius'), radius('border-bottom-right-radius'), radius('border-bottom-left-radius')],
    opacity: clamp(number(style.opacity, 1), 0, 1), fontFamily: style.fontFamily, fontSize: clamp(number(style.fontSize, 16), 1, 1000),
    fontWeight: number(style.fontWeight, 400), fontStyle: style.fontStyle, lineHeight: style.lineHeight === 'normal' ? null : number(style.lineHeight),
    letterSpacing: number(style.letterSpacing), textAlign: style.textAlign, textDecoration: style.textDecorationLine, whiteSpace: style.whiteSpace,
    clipsContent: ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX) || ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY),
    shadow: parseShadow(style.boxShadow), textTransform: style.textTransform
  };
}

function readLayout(style: CSSStyleDeclaration, element?: Element): ParsedLayout {
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
    absolute: style.position === 'absolute' || style.position === 'fixed', grow: number(style.flexGrow), shrink: number(style.flexShrink, 1), basis: style.flexBasis,
    zIndex: style.zIndex === 'auto' ? null : number(style.zIndex), offsets: {
      top: element ? authoredDimension(element, 'top') : style.top, right: element ? authoredDimension(element, 'right') : style.right,
      bottom: element ? authoredDimension(element, 'bottom') : style.bottom, left: element ? authoredDimension(element, 'left') : style.left
    }, alignSelf: style.alignSelf,
    order: number(style.order), wrap: flex && style.flexWrap !== 'nowrap'
  };
}

export async function parseRenderedHTML(rendered: RenderedHTML, options: ImportOptions): Promise<ParsedDocument> {
  options = { ...IMPORT_DEFAULTS, ...options };
  const doc = rendered.document;
  const view = doc.defaultView!;
  const warnings = [...rendered.warnings];
  const assets: Record<string, number[]> = {};
  const variableNames = collectCSSVariableNames(doc);
  const computedCache = new WeakMap<Element, CSSStyleDeclaration>();
  const computed = (el: Element) => { if (!computedCache.has(el)) computedCache.set(el, view.getComputedStyle(el)); return computedCache.get(el)!; };
  const skipped = (el: Element) => {
    const style = computed(el);
    return OMIT_TAGS.has(el.localName) || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || isAccessibilityHidden(style);
  };
  const warn = (code: string, node: string, message: string) => { if (warnings.length < 500) warnings.push({ code, node, message }); };
  let count = 0;
  const bounds = (rect: DOMRect): Bounds => ({ x: rect.left, y: rect.top, width: clamp(rect.width), height: clamp(rect.height) });
  const hasBlockChildren = (el: Element) => [...el.children].some(child => !['inline', 'inline-block', 'contents', 'none'].includes(computed(child).display) || ['img', 'svg'].includes(child.localName));
  const text = (el: HTMLElement) => el.innerText || el.textContent || '';
  function readBackground(node: ParsedNode, style: CSSStyleDeclaration): void {
    if (style.backgroundImage === 'none') return;
    const layers = splitCSSList(style.backgroundImage);
    const urls = layers.map(layer => layer.match(/^url\(["']?(.*?)["']?\)$/)?.[1]);
    const imageIndex = urls.findIndex(url => url !== undefined);
    const gradientIndex = layers.findIndex(layer => /^linear-gradient\(/i.test(layer));
    if (imageIndex >= 0) {
      const layerValue = (value: string) => { const values = splitCSSList(value); return values[imageIndex % values.length]!; };
      node.style.backgroundImage = { key: '', src: urls[imageIndex]!, alt: 'background', fit: layerValue(style.backgroundSize), position: layerValue(style.backgroundPosition), repeat: layerValue(style.backgroundRepeat), layerIndex: imageIndex };
    }
    if (gradientIndex >= 0) {
      const result = parseLinearGradient(layers[gradientIndex]!);
      if (result.gradient) node.style.backgroundGradient = { ...result.gradient, layerIndex: gradientIndex };
      else if (result.fallback) node.style.background = result.fallback;
      if (result.warning) warn('GRADIENT_FALLBACK', node.name, result.warning);
    }
    if (layers.some((layer, index) => !urls[index] && index !== gradientIndex && layer !== 'none')) warn('BACKGROUND_IMAGE', node.name, '미지원 배경 레이어는 생략하고 지원되는 배경 Fill을 유지합니다.');
    if (layers.length > 1) warn('BACKGROUND_LAYERS', node.name, '다중 배경은 첫 번째 URL 이미지와 첫 번째 Linear Gradient 및 배경색을 유지합니다.');
  }
  function parse(el: Element, depth: number): ParsedNode[] {
    if (OMIT_TAGS.has(el.localName)) return [];
    if (count >= LIMITS.nodes || depth > LIMITS.depth) { warn('TREE_LIMIT', layerName(el), '노드 수 또는 중첩 깊이 제한으로 일부 요소를 생략했습니다.'); return []; }
    const style = computed(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return [];
    if (isAccessibilityHidden(style)) {
      if (options.debug) warn('ACCESSIBILITY_HIDDEN', layerName(el), `Skipped Accessibility Hidden Element: ${selector(el)}${el.hasAttribute('for') ? `[for=${JSON.stringify(el.getAttribute('for'))}]` : ''}`);
      return [];
    }
    if (style.display === 'contents') {
      warn('DISPLAY_CONTENTS', layerName(el), 'display:contents 요소의 자식들을 부모에 배치했습니다.');
      return parseChildren(el, depth);
    }
    const rect = bounds(el.getBoundingClientRect());
    if (rect.width === 0 && rect.height === 0 && !el.children.length) return [];
    const name = layerName(el);
    const hasFormContent = TEXT_TAGS.has(el.localName) && [...el.querySelectorAll('input, textarea, select')].some(child => {
      const box = child.getBoundingClientRect();
      return readFormContent(child) !== null && (box.width > 0 || box.height > 0) && !['hidden', 'collapse'].includes(computed(child).visibility);
    });
    const inlineElements = [...el.children].filter(child => !skipped(child));
    const inlineContainer = TEXT_TAGS.has(el.localName) || (inlineElements.length > 0 && inlineElements.every(child =>
      ['inline', 'inline-block', 'inline-flex'].includes(computed(child).display) || ['svg', 'img'].includes(child.localName)));
    const separateInline = inlineContainer && needsInlineChildren(el, computed, skipped);
    const isText = TEXT_TAGS.has(el.localName) && !hasBlockChildren(el) && !hasFormContent && !separateInline;
    const node: ParsedNode = {
      type: el.localName === 'svg' ? 'SVG' : el.localName === 'img' ? 'IMAGE' : isText ? 'TEXT' : 'FRAME', tagName: el.localName, name, rect,
      layout: readLayout(style, el), size: inferSizing(el, style, el.parentElement ? computed(el.parentElement) : null, rect.width, rect.height),
      style: readStyle(style), children: [], source: { selector: selector(el), id: el.id, classNames: [...el.classList], styleless: !el.hasAttribute('style') },
      cssVariables: readCSSVariables(style, variableNames, selector(el))
    };
    count++;
    if (node.layout.absolute) warn('ABSOLUTE_ELEMENT', name, '절대 위치를 유지하고 Auto Layout 흐름에서 분리했습니다.');
    if (node.layout.wrap) { node.layout.direction = 'NONE'; node.size.heightMode = 'FIXED'; warn('FLEX_WRAP', name, '여러 줄 Flexbox는 측정된 고정 위치로 유지했습니다.'); }
    if (style.display.includes('grid')) parseGrid(node, style, el, warn);
    if (style.transform !== 'none') warn('TRANSFORM', name, 'CSS transform은 측정된 경계 상자로 단순화했습니다.');
    if (style.cssFloat !== 'none') warn('FLOAT', name, 'float는 측정된 위치만 유지합니다.');
    readBackground(node, style);
    if (style.boxShadow !== 'none' && splitCSSList(style.boxShadow).length > 1) warn('MULTIPLE_SHADOWS', name, '다중 shadow는 첫 번째 효과만 반영합니다.');
    if (style.boxShadow !== 'none' && !node.style.shadow) warn('BOX_SHADOW', name, '그림자 문법을 해석할 수 없습니다.');
    if (style.getPropertyValue('backdrop-filter') && style.getPropertyValue('backdrop-filter') !== 'none') warn('UNSUPPORTED_CSS', name, `Unsupported: backdrop-filter (${selector(el)})`);
    if (['space-around', 'space-evenly'].includes(style.justifyContent)) warn('JUSTIFY_CONTENT', name, `${style.justifyContent}를 시작 정렬로 단순화합니다.`);
    if (style.alignItems.includes('baseline')) warn('BASELINE', name, 'baseline 정렬을 시작 정렬로 단순화합니다.');
    for (const pseudo of ['::before', '::after']) {
      const content = view.getComputedStyle(el, pseudo).content;
      if (content && !['none', 'normal', '""'].includes(content)) warn('PSEUDO_ELEMENT', name, `${pseudo} 생성 콘텐츠는 생략했습니다.`);
    }
    const formContent = readFormContent(el);
    if (node.type === 'TEXT') {
      const range = doc.createRange(); range.selectNodeContents(el);
      node.size.widthMode = inferTextWidth(node.size, style, node.layout, range);
      node.text = text(el as HTMLElement);
      node.text = transformText(node.text, style.textTransform);
      if (el.children.length) warn('INLINE_TEXT', name, '여러 inline 텍스트 스타일을 부모의 스타일로 통합했습니다.');
      const noWrap = ['nowrap', 'pre'].includes(style.whiteSpace) && node.size.widthMode !== 'HUG';
      const dimensionBox = ['inline', 'inline-block'].includes(style.display) || ['span', 'label', 'a', 'strong', 'small', 'em', 'b', 'i', 'code'].includes(el.localName);
      if ((hasInlineBoxStyle(el, style, dimensionBox) || noWrap) && count < LIMITS.nodes && depth < LIMITS.depth) {
        // Keep decorated text editable, with a frame carrying its box styling.
        node.type = 'FRAME';
        const child: ParsedNode = { ...node, type: 'TEXT', name: `${name} / text`, rect: bounds(range.getBoundingClientRect()),
          style: { ...node.style, opacity: 1, background: null, backgroundImage: undefined, backgroundGradient: undefined, shadow: undefined, borderWidths: zero(), radii: [0, 0, 0, 0] },
          layout: { ...node.layout, direction: 'NONE', padding: zero(), margin: zero(), absolute: false }, children: [] };
        child.size = { ...node.size, width: child.rect.width, height: child.rect.height, widthMode: noWrap || node.size.widthMode === 'HUG' ? 'HUG' : 'FIXED', heightMode: 'HUG' };
        node.children = [child]; node.text = undefined; count++;
        if (options.autoLayout && ['inline', 'inline-block'].includes(style.display) && isSingleTextLine(range)) {
          node.layout.direction = 'HORIZONTAL'; node.layout.align = 'BASELINE'; node.layout.justify = 'MIN'; node.layout.gap = 0;
          child.size.widthMode = 'HUG';
          if (node.size.authoredHeight === 'auto') node.size.heightMode = 'HUG';
        }
      }
    } else if (formContent !== null) {
      const content = formContent;
      // Retain the control's measured box; its native value is not a DOM child.
      node.layout.direction = 'NONE';
      node.size.heightMode = 'FIXED';
      if (content.text && count < LIMITS.nodes && depth < LIMITS.depth) {
        const contentStyle = content.placeholder ? view.getComputedStyle(el, '::placeholder') : style;
        content.text = transformText(content.text, contentStyle.textTransform);
        const textRect = measureFormText(el, rect, contentStyle, content);
        const child: ParsedNode = {
          type: 'TEXT', tagName: '#text', name: `${name} / text`, text: content.text, rect: textRect,
          size: { width: textRect.width, height: textRect.height, widthMode: content.multiline ? 'FIXED' : 'HUG', heightMode: 'HUG', authoredWidth: 'auto', authoredHeight: 'auto' },
          layout: { ...node.layout, display: 'inline', direction: 'NONE', padding: zero(), margin: zero(), absolute: false, position: 'static', grow: 0, order: 0, alignSelf: 'auto', wrap: false, zIndex: null },
          style: { ...readStyle(contentStyle), background: null, backgroundImage: undefined, shadow: undefined, opacity: content.placeholder ? number(contentStyle.opacity, 1) : 1, borderWidths: zero(), radii: [0, 0, 0, 0] },
          source: { selector: `${selector(el)} / text`, id: '', classNames: [], synthetic: true }, children: []
        };
        node.children = [child]; count++;
      } else if (content.text) warn('TREE_LIMIT', name, '노드 수 또는 중첩 깊이 제한으로 control 텍스트를 생략했습니다.');
    } else if (node.type === 'SVG') {
      try { node.svg = serializeSVG(el); }
      catch (error) { warn('SVG_SERIALIZE', name, errorMessage(error)); }
    } else if (node.type === 'IMAGE') {
      const img = el as HTMLImageElement;
      node.image = { key: '', src: img.getAttribute('src') || img.getAttribute('data-original-src') || '', alt: img.alt, fit: style.objectFit };
    } else if (UNSUPPORTED_TAGS.has(el.localName) || el.localName.includes('-')) {
      warn('UNSUPPORTED_ELEMENT', name, `${el.localName}은 편집 가능한 빈 Frame으로 대체했습니다.`);
    } else {
      node.children = parseChildren(el, depth, separateInline);
      if (options.autoLayout && separateInline) configureInlineRow(el, node, style);
    }
    const gridRows = node.grid ? Math.ceil(node.children.filter(child => !child.layout.absolute).length / node.grid.columns.length) : 0;
    const gridExtras = node.grid ? gridRows * (node.grid.columns.length + 1) : 0;
    if (node.grid?.supported && options.autoLayout && count + gridExtras < LIMITS.nodes && depth < LIMITS.depth - 2) {
      buildGridRows(node); count += gridExtras;
    }
    else if (node.grid?.supported && options.autoLayout) { node.grid.supported = false; warn('GRID_FALLBACK', name, '노드/깊이 제한으로 Grid 행 생성을 생략했습니다.'); }
    if (!options.autoLayout) node.layout.direction = 'NONE';
    return [node];
  }
  function parseChildren(el: Element, depth: number, inlineContent = false): ParsedNode[] {
    if (depth >= LIMITS.depth) { warn('TREE_LIMIT', layerName(el), '중첩 깊이 제한으로 자식 요소를 생략했습니다.'); return []; }
    const children: ParsedNode[] = [];
    for (const child of [...el.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) children.push(...parse(child as Element, depth + 1));
      else if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim() && count < LIMITS.nodes) {
        const style = computed(el);
        const preserve = ['pre', 'pre-wrap', 'break-spaces'].includes(style.whiteSpace);
        const range = doc.createRange(); range.selectNode(child);
        if (inlineContent && !preserve) {
          range.setStart(child, child.textContent.search(/\S/));
          range.setEnd(child, child.textContent.length - (child.textContent.match(/\s*$/)?.[0].length || 0));
        }
        const rect = bounds(range.getBoundingClientRect());
        const value = transformText(preserve ? child.textContent : child.textContent.replace(/\s+/g, ' ').trim(), style.textTransform);
        if (!rect.width && !rect.height) continue;
        children.push({ type: 'TEXT', tagName: '#text', name: `${layerName(el)} / text`, text: value, rect,
          size: { width: rect.width, height: rect.height, widthMode: isSingleTextLine(range) || ['nowrap', 'pre'].includes(style.whiteSpace) ? 'HUG' : 'FIXED', heightMode: 'HUG', authoredWidth: 'auto', authoredHeight: 'auto' },
          layout: { ...readLayout(style), display: 'inline', direction: 'NONE', padding: zero(), margin: zero(), absolute: false, grow: 0, order: 0, alignSelf: 'auto', wrap: false },
          style: { ...readStyle(style), background: null, backgroundImage: undefined, shadow: undefined, opacity: 1, borderWidths: zero(), radii: [0, 0, 0, 0] },
          source: { selector: `${selector(el)} / text`, id: '', classNames: [], synthetic: true }, children: [] });
        count++;
      }
    }
    return children;
  }
  const body = parse(doc.body, 0)[0];
  if (!body) throw new Error('변환할 수 있는 표시 요소가 없습니다.');
  const bodyStyle = view.getComputedStyle(doc.body);
  const htmlStyle = computed(doc.documentElement);
  if (!body.style.background?.a && bodyStyle.backgroundImage === 'none' && /linear-gradient\(/i.test(htmlStyle.backgroundImage)) readBackground(body, htmlStyle);
  // A sole undecorated body wrapper may be collapsed into the imported viewport frame.
  const collapse = body.children.length === 1 && body.children[0]!.type === 'FRAME' && !body.children[0]!.layout.absolute &&
    Object.values(body.children[0]!.layout.margin).every(v => v === 0) && bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)' &&
    bodyStyle.display === 'block' && Object.values(body.layout.padding).every(v => v === 0) && Object.values(body.layout.margin).every(v => v === 0) &&
    Object.values(body.style.borderWidths).every(v => v === 0) && body.style.opacity === 1 && !body.style.shadow && !body.style.backgroundImage && !body.style.backgroundGradient && !body.style.background?.a && !body.style.clipsContent;
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
  if ((root.size.minWidth != null && root.size.minWidth > options.viewport) || (root.size.maxWidth != null && root.size.maxWidth < options.viewport)) {
    warn('VIEWPORT_CONSTRAINT', root.name, '최상위 Frame은 입력한 viewport 폭을 우선하므로 충돌하는 min/max-width를 해제했습니다.');
    root.size.minWidth = null; root.size.maxWidth = null;
  }
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
  if (options.optimizeWrappers) optimizeEmptyWrappers(root);
  await collectImages(root, doc, options, assets, warn);
  return { version: 1, root, options, assets, warnings, cssVariables: readCSSVariables(computed(doc.documentElement), variableNames, ':root') };
}

function transformText(text: string, transform: string): string {
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  if (transform === 'capitalize') return text.replace(/\b\p{L}/gu, letter => letter.toUpperCase());
  return text;
}

export async function parseHTML(html: string, options: ImportOptions, host: HTMLElement, localAssets: LocalAssets = {}): Promise<ParsedDocument> {
  const rendered = await renderHTML(html, options.viewport, options.viewportHeight, host, localAssets);
  try { return await parseRenderedHTML(rendered, options); }
  finally { rendered.dispose(); }
}

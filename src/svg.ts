import { LIMITS } from './types';

/** Inline computed presentation styles and retain vector geometry/defs for createNodeFromSvg(). */
export function serializeSVG(element: Element): string {
  const view = element.ownerDocument.defaultView!;
  const originals = [element, ...element.querySelectorAll('*')];
  if (originals.length > 1000) throw new Error('SVG의 내부 요소가 1,000개 제한을 초과했습니다.');
  const clone = element.cloneNode(true) as Element;
  const copies = [clone, ...clone.querySelectorAll('*')];
  const properties = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'color', 'font-family', 'font-size', 'font-weight', 'stop-color', 'stop-opacity', 'clip-rule', 'clip-path', 'mask'];
  originals.forEach((original, index) => {
    const copy = copies[index]!;
    if (['script', 'foreignObject', 'iframe', 'animate', 'animateTransform', 'set'].includes(copy.localName)) { copy.remove(); return; }
    const css = view.getComputedStyle(original);
    if (css.display === 'none' || css.visibility === 'hidden') { copy.remove(); return; }
    for (const attribute of [...copy.attributes]) {
      if (/^on/i.test(attribute.name)) copy.removeAttribute(attribute.name);
      if (['href', 'xlink:href'].includes(attribute.name) && !attribute.value.startsWith('#')) copy.removeAttribute(attribute.name);
    }
    for (const property of properties) {
      const value = css.getPropertyValue(property).replace(/url\(["']?[^)]*#([^"')]+)["']?\)/g, 'url(#$1)');
      if (value) copy.setAttribute(property, value);
    }
    copy.removeAttribute('class'); copy.removeAttribute('style');
  });
  const rect = element.getBoundingClientRect();
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.max(.01, rect.width))); clone.setAttribute('height', String(Math.max(.01, rect.height)));
  // Top-level CSS opacity is applied once on the resulting Figma frame.
  clone.setAttribute('opacity', '1');
  const result = new XMLSerializer().serializeToString(clone);
  if (result.length > LIMITS.fileBytes) throw new Error('SVG 데이터가 너무 큽니다.');
  return result;
}

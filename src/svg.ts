import { LIMITS } from './types';

/** Replace circle dashes with their visible arc geometry before the SVG importer interprets strokes. */
function circleDashPath(circle: SVGCircleElement, css: CSSStyleDeclaration): string | null {
  if (css.fill !== 'none' || css.stroke === 'none' || css.strokeDasharray === 'none') return null;
  const cx = circle.cx.baseVal.value, cy = circle.cy.baseVal.value, r = circle.r.baseVal.value;
  if (!Number.isFinite(r) || r <= 0) return null;
  const circumference = Math.PI * 2 * r;
  const svg = circle.ownerSVGElement!;
  const box = svg.viewBox.baseVal;
  const diagonal = Math.hypot(box.width || svg.width.baseVal.value, box.height || svg.height.baseVal.value) / Math.SQRT2;
  const length = (token: string): number => {
    const match = token.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|%)?$/);
    return match ? Number(match[1]) * (match[2] === '%' ? diagonal / 100 : 1) : NaN;
  };
  let pattern = css.strokeDasharray.split(/[\s,]+/).filter(Boolean).map(length);
  const offset = length(css.strokeDashoffset || '0');
  if (!pattern.length || pattern.some(value => !Number.isFinite(value) || value < 0) || !Number.isFinite(offset)) return null;
  if (pattern.length % 2) pattern = [...pattern, ...pattern];
  const authoredLength = circle.hasAttribute('pathLength') ? circle.pathLength.baseVal : circumference;
  if (authoredLength <= 0) return null;
  const scale = circumference / authoredLength;
  pattern = pattern.map(value => value * scale);
  const period = pattern.reduce((sum, value) => sum + value, 0);
  if (period <= 0) return null;
  const segments: [number, number][] = [];
  if (pattern.every((value, index) => index % 2 === 0 || value === 0)) segments.push([0, circumference]);
  else {
    // Zero-length round dots and extremely dense patterns keep their original SVG representation.
    if (pattern.some(value => value === 0)) return null;
    let position = -((offset * scale % period + period) % period), index = 0;
    while (position < circumference) {
      if (index >= 512) return null;
      const end = position + pattern[index % pattern.length]!;
      if (index % 2 === 0 && end > 0) segments.push([Math.max(0, position), Math.min(circumference, end)]);
      position = end; index++;
    }
  }
  // A closed circle's first/last painted intervals meet at its seam; keep that arc continuous.
  if (segments.length > 1 && segments[0]![0] === 0 && segments[segments.length - 1]![1] === circumference) {
    const first = segments.shift()!, last = segments.pop()!;
    segments.push([last[0], circumference + first[1]]);
  }
  const point = (distance: number) => `${cx + r * Math.cos(distance / r)} ${cy + r * Math.sin(distance / r)}`;
  return segments.map(([start, end]) => {
    // Two connected arc commands represent a full turn without coincident SVG A endpoints.
    const split = end - start >= circumference - 1e-8 ? [start + circumference / 2, end] : [end];
    let previous = start;
    return `M ${point(start)} ` + split.map(next => {
      const command = `A ${r} ${r} 0 ${next - previous > Math.PI * r ? 1 : 0} 1 ${point(next)}`;
      previous = next; return command;
    }).join(' ');
  }).join(' ');
}

function normalizeDashedCircle(original: SVGCircleElement, copy: Element, css: CSSStyleDeclaration): void {
  const d = circleDashPath(original, css);
  if (d === null) return;
  if (!d) { copy.remove(); return; }
  const path = original.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
  for (const attribute of [...copy.attributes]) path.setAttribute(attribute.name, attribute.value);
  for (const key of ['cx', 'cy', 'r', 'pathLength']) path.removeAttribute(key);
  path.setAttribute('d', d); path.setAttribute('stroke-dasharray', 'none'); path.setAttribute('stroke-dashoffset', '0');
  // Internal SVG styles may still target this id, so disable only the already-expanded dash pattern.
  path.style.setProperty('stroke-dasharray', 'none', 'important'); path.style.setProperty('stroke-dashoffset', '0', 'important');
  if (css.transform !== 'none') {
    const matrix = new DOMMatrix(css.transform);
    if (!matrix.is2D) return;
    let [ox, oy] = css.transformOrigin.split(/\s+/).map(value => parseFloat(value));
    if (css.transformBox === 'fill-box' || css.transformBox === 'stroke-box') {
      const box = original.getBBox(); ox! += box.x; oy! += box.y;
      if (css.transformBox === 'stroke-box') { const inset = parseFloat(css.strokeWidth) / 2; ox! -= inset; oy! -= inset; }
    }
    const transformed = new DOMMatrix().translate(ox || 0, oy || 0).multiply(matrix).translate(-(ox || 0), -(oy || 0));
    const values = [transformed.a, transformed.b, transformed.c, transformed.d, transformed.e, transformed.f];
    path.setAttribute('transform', `matrix(${values.join(' ')})`);
    path.style.setProperty('transform', `matrix(${values.join(',')})`, 'important');
    path.style.setProperty('transform-origin', '0 0', 'important'); path.style.setProperty('transform-box', 'view-box', 'important');
  }
  copy.replaceWith(path);
}

/** Inline computed presentation styles and retain vector geometry/defs for createNodeFromSvg(). */
export function serializeSVG(element: Element, warn: (message: string) => void = () => {}): string {
  const view = element.ownerDocument.defaultView!;
  const originals = [element, ...element.querySelectorAll('*')];
  if (originals.length > 1000) throw new Error('SVG의 내부 요소가 1,000개 제한을 초과했습니다.');
  const clone = element.cloneNode(true) as Element;
  const copies = [clone, ...clone.querySelectorAll('*')];
  const properties = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color', 'font-family', 'font-size', 'font-weight', 'stop-color', 'stop-opacity', 'clip-rule', 'clip-path', 'mask'];
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
    if (original.localName === 'circle' && css.strokeDasharray !== 'none') {
      try { normalizeDashedCircle(original as SVGCircleElement, copy, css); }
      catch { warn('Donut stroke를 명시적인 Arc로 변환하지 못해 원본 SVG stroke 속성을 유지합니다.'); }
    }
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

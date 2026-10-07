import type { ParsedSize, SizingMode } from './types';
import { number } from './utils';

/** Preserve auto/%/fit-content using Typed OM; fall back to accessible stylesheet declarations. */
export function authoredDimension(el: Element, property: 'width' | 'height' | 'grid-template-columns' | 'top' | 'right' | 'bottom' | 'left'): string {
  const typed = el as Element & { computedStyleMap?: () => { get: (key: string) => { toString(): string } | undefined } };
  try { const value = typed.computedStyleMap?.().get(property); if (value) return value.toString(); } catch { /* older Chromium */ }
  const inline = (el as HTMLElement).style?.getPropertyValue(property);
  if (inline) return inline;
  let declared = '';
  const inspect = (rules: CSSRuleList) => {
    for (const rule of [...rules]) {
      if ('selectorText' in rule && 'style' in rule) {
        const css = rule as CSSStyleRule;
        try { if (el.matches(css.selectorText) && css.style.getPropertyValue(property)) declared = css.style.getPropertyValue(property); } catch { /* unsupported selector */ }
      } else if ('cssRules' in rule) {
        if (rule.type === 4 && !el.ownerDocument.defaultView?.matchMedia((rule as CSSMediaRule).conditionText).matches) continue;
        inspect((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of [...el.ownerDocument.styleSheets]) { try { inspect(sheet.cssRules); } catch { /* opaque external stylesheet */ } }
  return declared || 'auto';
}

export function inferSizing(el: Element, style: CSSStyleDeclaration, parentStyle: CSSStyleDeclaration | null, width: number, height: number): ParsedSize {
  const authoredWidth = authoredDimension(el, 'width'), authoredHeight = authoredDimension(el, 'height');
  const parentFlex = !!parentStyle && ['flex', 'inline-flex'].includes(parentStyle.display) && parentStyle.flexWrap === 'nowrap';
  const column = parentStyle?.flexDirection.startsWith('column');
  const align = style.alignSelf === 'auto' ? parentStyle?.alignItems : style.alignSelf;
  const intrinsic = (value: string) => /^(auto|fit-content|max-content|min-content)/.test(value);
  function mode(axis: 'width' | 'height', authored: string, measured: number): SizingMode {
    const primary = axis === 'width' ? !column : column;
    if (parentFlex && (authored === '100%' || (primary && number(style.flexGrow) > 0))) return 'FILL';
    if (parentFlex && !primary && authored === 'auto' && ['stretch', 'normal'].includes(align || '')) return 'FILL';
    // A definite flex-basis or a shrunk explicit size must keep the browser's resulting px size.
    if (parentFlex && primary && style.flexBasis !== 'auto' && style.flexBasis !== 'content') return 'FIXED';
    if (!intrinsic(authored)) return 'FIXED';
    if (axis === 'width' && !parentFlex && !['inline', 'inline-block', 'inline-flex'].includes(style.display)) return 'FIXED';
    if (axis === 'width' && style.whiteSpace !== 'nowrap' && style.whiteSpace !== 'pre' && measured > 0 && el.localName === 'p') return 'FIXED';
    return 'HUG';
  }
  const constraint = (value: string) => /^\d*\.?\d+px$/.test(value) ? Math.max(0, number(value)) : null;
  return { width, height, authoredWidth, authoredHeight, widthMode: mode('width', authoredWidth, width), heightMode: mode('height', authoredHeight, height),
    minWidth: constraint(style.minWidth), maxWidth: constraint(style.maxWidth), minHeight: constraint(style.minHeight), maxHeight: constraint(style.maxHeight) };
}

import type { CSSVariableInfo } from './types';

/** Metadata for a future Figma Variables adapter; visual values still come from computed CSS. */
export function collectCSSVariableNames(doc: Document): string[] {
  const names = new Set<string>();
  const read = (style: CSSStyleDeclaration) => { for (const name of [...style]) if (name.startsWith('--')) names.add(name); };
  const visit = (rules: CSSRuleList) => {
    for (const rule of [...rules]) {
      if ('style' in rule) read((rule as CSSStyleRule).style);
      if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of [...doc.styleSheets]) { try { visit(sheet.cssRules); } catch { /* external CSS is opaque */ } }
  for (const element of doc.querySelectorAll<HTMLElement>('[style]')) read(element.style);
  return [...names].slice(0, 100);
}
export function readCSSVariables(style: CSSStyleDeclaration, names: string[], scope: string): CSSVariableInfo[] {
  return names.map(name => ({ name, value: style.getPropertyValue(name).trim(), scope })).filter(variable => variable.value);
}

import type { ConversionWarning, ParsedNode } from './types';
export function warningCategory(code: string): string {
  if (/FONT/.test(code)) return 'Fonts';
  if (/IMAGE|ASSET|BACKGROUND/.test(code)) return 'Images';
  if (/GRID/.test(code)) return 'Grid Fallback';
  if (/UNSUPPORTED|TRANSFORM|FLOAT|PSEUDO|SHADOW|BORDER_COLORS/.test(code)) return 'Unsupported CSS';
  if (/FAILED|LIMIT|TIMEOUT|SVG/.test(code)) return 'Stability';
  return 'Layout';
}
export function enrichWarnings(warnings: ConversionWarning[], root: ParsedNode): Record<string, number> {
  const elements = new Map<string, string>(); const stack = [root];
  while (stack.length) { const node = stack.pop()!; stack.push(...node.children); if (node.source && !elements.has(node.name)) elements.set(node.name, node.source.selector); }
  const groups: Record<string, number> = {};
  for (const warning of warnings) {
    warning.category ||= warningCategory(warning.code);
    warning.element ||= elements.get(warning.node) || warning.node;
    groups[warning.category] = (groups[warning.category] || 0) + 1;
  }
  return groups;
}

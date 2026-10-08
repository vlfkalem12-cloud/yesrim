import type { ConversionOutcome, ConversionReport, ConversionWarning, ImportOptions, ParsedNode, ReportWarning, ReportWarningCode, WarningContext } from './types';
export function warningCategory(code: string): string {
  if (code === 'BACKGROUND_DEBUG' || code === 'HEIGHT_SIZING' || code === 'HEIGHT_HIERARCHY') return 'Debug';
  if (/FONT/.test(code)) return 'Fonts';
  if (/GRADIENT|BACKGROUND_LAYER/.test(code)) return 'Unsupported CSS';
  if (/IMAGE|ASSET|BACKGROUND/.test(code)) return 'Images';
  if (/GRID/.test(code)) return 'Grid Fallback';
  if (/UNSUPPORTED|TRANSFORM|FLOAT|PSEUDO|SHADOW|BORDER_COLORS/.test(code)) return 'Unsupported CSS';
  if (/FAILED|LIMIT|TIMEOUT|SVG/.test(code)) return 'Stability';
  return 'Layout';
}
export function enrichWarnings(warnings: ConversionWarning[], root: ParsedNode): Record<string, number> {
  const elements = new Map<string, Set<string>>(); const stack = [root];
  while (stack.length) {
    const node = stack.pop()!; stack.push(...node.children);
    if (node.source) { if (!elements.has(node.name)) elements.set(node.name, new Set()); elements.get(node.name)!.add(node.source.selector); }
  }
  const groups: Record<string, number> = {};
  for (const warning of warnings) {
    warning.category ||= warningCategory(warning.code);
    const sources = elements.get(warning.node);
    warning.element ||= sources?.size === 1 ? [...sources][0]! : warning.node;
    groups[warning.category] = (groups[warning.category] || 0) + 1;
  }
  return groups;
}

export const REPORT_LABELS: Record<ReportWarningCode, string> = {
  EXTERNAL_RESOURCE: '외부 리소스', UNSUPPORTED_STYLE: '지원하지 않는 스타일', FONT_FALLBACK: '글꼴 대체',
  IMAGE_ERROR: '이미지 오류', SVG_ERROR: 'SVG 오류', SIZING_FALLBACK: '크기 설정 대체', CONVERSION_WARNING: '변환 확인'
};
const REPORT_MESSAGES: Record<ReportWarningCode, string> = {
  EXTERNAL_RESOURCE: '외부 리소스를 불러오지 못해 일부 스타일이나 글꼴이 적용되지 않았을 수 있습니다.',
  UNSUPPORTED_STYLE: '지원하지 않는 스타일이 적용되지 않았거나 대체 방식으로 표현되었습니다.',
  FONT_FALLBACK: '일부 글꼴이 다른 글꼴로 대체되었거나 텍스트를 표시하지 못했습니다.',
  IMAGE_ERROR: '일부 이미지를 불러오거나 변환하지 못했습니다.', SVG_ERROR: '일부 SVG 요소를 변환하지 못했습니다.',
  SIZING_FALLBACK: '일부 요소의 크기 설정이 대체 방식으로 적용되었습니다.', CONVERSION_WARNING: '일부 요소가 생략되거나 대체되었습니다. 결과를 확인해 주세요.'
};
const INFORMATION = new Set(['FIXED_ELEMENT', 'ABSOLUTE_ELEMENT', 'FIXED_POSITION', 'DISPLAY_CONTENTS', 'ACCESSIBILITY_HIDDEN', 'BACKGROUND_DEBUG', 'HEIGHT_SIZING', 'HEIGHT_HIERARCHY']);
const EXTERNAL = new Set(['RELATIVE_ASSET', 'STYLESHEET_LOAD', 'RESOURCE_TIMEOUT', 'WEB_FONT_TIMEOUT', 'WEB_FONT_LOAD']);
const SIZING = new Set(['SIZING_CYCLE', 'SIZING_API', 'SIZE_CONSTRAINT', 'HEIGHT_LAYOUT', 'FLEX_WRAP', 'FLEX_GROW_RATIO', 'GRID_FALLBACK', 'VIEWPORT_CONSTRAINT', 'VIEWPORT_OVERFLOW']);
const STYLES = new Set(['UNSUPPORTED_CSS', 'TRANSFORM', 'FLOAT', 'MULTIPLE_SHADOWS', 'BOX_SHADOW', 'JUSTIFY_CONTENT', 'BASELINE', 'PSEUDO_ELEMENT', 'INLINE_TEXT', 'GRADIENT_FALLBACK', 'BACKGROUND_LAYER', 'BACKGROUND_POSITION', 'BACKGROUND_REPEAT', 'BACKGROUND_SIZE', 'SHADOW_SPREAD', 'BORDER_COLORS', 'IMAGE_STRETCH', 'Z_INDEX_FLOW', 'ALIGN_SELF', 'NEGATIVE_MARGIN', 'TEXT_RANGE_STYLE']);
export function reportCode(warning: ConversionWarning, options?: ImportOptions): ReportWarningCode | null {
  if (INFORMATION.has(warning.code) || warning.category === 'Debug') return null;
  if (EXTERNAL.has(warning.code)) return 'EXTERNAL_RESOURCE';
  if (/FONT/.test(warning.code)) return 'FONT_FALLBACK';
  if (['IMAGE_SOURCE', 'IMAGE_LOAD', 'IMAGE_PLACEHOLDER'].includes(warning.code)) return options?.images === false ? null : 'IMAGE_ERROR';
  if (['SVG_IMPORT', 'SVG_SERIALIZE', 'SVG_DASH'].includes(warning.code)) return 'SVG_ERROR';
  if (SIZING.has(warning.code)) return 'SIZING_FALLBACK';
  if (STYLES.has(warning.code)) return options?.styles === false ? null : 'UNSUPPORTED_STYLE';
  return 'CONVERSION_WARNING';
}
/** User-facing text is a single bounded line; full diagnostics remain in Debug/console. */
export function reportText(value: string): string { return value.split(/[\r\n]/)[0]!.slice(0, 400); }
export function warningElement(el: Element): string {
  const tag = el.localName;
  if (el.id) return `${tag}#${el.id}`;
  const label = el.getAttribute('aria-label')?.trim();
  if (label) return `${tag}[aria-label=${JSON.stringify(label)}]`;
  return `${tag}${[...el.classList].slice(0, 3).map(name => `.${name}`).join('')}`;
}
export function warningNode(node: ParsedNode): string { return node.source?.selector || node.name; }

/** Preserve raw codes for developers; only collapse identical codes and causes. */
export function groupReportWarnings(warnings: ConversionWarning[], options?: ImportOptions): ReportWarning[] {
  const grouped = new Map<string, ReportWarning>();
  for (const warning of warnings) {
    const code = reportCode(warning, options); if (!code) continue;
    const detail: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(warning.detail || {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (typeof value === 'string') detail[key] = reportText(value);
      else if (typeof value === 'number' && Number.isFinite(value)) detail[key] = value;
    }
    // Structured causes exclude the element, so 100 identical font replacements form one group.
    if (!Object.keys(detail).length) detail.reason = reportText(warning.message);
    const cause = warning.detail && Object.keys(warning.detail).length ? warning.detail : { reason: warning.message };
    const key = JSON.stringify([code, warning.code, Object.entries(cause).sort(([a], [b]) => a.localeCompare(b))]);
    let group = grouped.get(key);
    if (!group) {
      group = { code, sourceCode: warning.code, severity: 'warning', message: REPORT_MESSAGES[code], count: 0, locations: [], detail };
      if (['RELATIVE_ASSET', 'STYLESHEET_LOAD'].includes(warning.code)) group.message = '외부 스타일시트를 불러오지 못해 일부 스타일이 적용되지 않았을 수 있습니다.';
      grouped.set(key, group);
    }
    group.count += warning.occurrences || 1;
    for (const location of warning.locations || [warning.element || warning.node]) {
      const text = reportText(location);
      if (text && group.locations.length < 5 && !group.locations.includes(text)) group.locations.push(text);
    }
  }
  return [...grouped.values()];
}
export function conversionOutcome(report: ConversionReport, fileName: string, options?: ImportOptions): ConversionOutcome {
  const warnings = groupReportWarnings(report.warnings, options);
  const warningTypes: ConversionOutcome['warningTypes'] = {};
  for (const warning of warnings) warningTypes[warning.code] = (warningTypes[warning.code] || 0) + 1;
  return { status: warnings.length ? 'SUCCESS_WITH_WARNINGS' : 'SUCCESS', fileName, result: { frameCreated: true, frameCount: 1 }, warningCount: warnings.length, warningTypes, warnings };
}
export function failedOutcome(fileName: string, message: string): ConversionOutcome {
  return { status: 'ERROR', fileName, result: { frameCreated: false, frameCount: 0 }, warningCount: 0, warningTypes: {}, warnings: [], errorMessage: reportText(message) };
}

/** Bounded raw diagnostics with accurate repeat counts and representative locations. */
export function warningCollector(warnings: ConversionWarning[], limit: number) {
  const seen = new Map(warnings.map(w => [JSON.stringify([w.code, w.node, w.message, w.detail]), w]));
  return (code: string, node: string, message: string, context: WarningContext = {}): void => {
    const key = JSON.stringify([code, node, message, context.detail]);
    const existing = seen.get(key);
    if (existing) {
      existing.occurrences = (existing.occurrences || 1) + 1;
      if (context.element && !existing.locations?.includes(context.element)) {
        existing.locations ||= existing.element ? [existing.element] : [];
        if (existing.locations.length < 5 && !existing.locations.includes(context.element)) existing.locations.push(context.element);
      }
    } else if (warnings.length < limit) {
      const warning = { code, node, message, ...context }; warnings.push(warning); seen.set(key, warning);
    }
  };
}

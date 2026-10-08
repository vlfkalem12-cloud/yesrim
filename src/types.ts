export type SizingMode = 'FIXED' | 'FILL' | 'HUG';
export type HeightIntent = 'fixed' | 'auto' | 'intrinsic' | 'percent' | 'viewport' | 'min-content' | 'max-content';
export interface Insets { top: number; right: number; bottom: number; left: number }
export interface Bounds { x: number; y: number; width: number; height: number }
export interface Color { r: number; g: number; b: number; a: number }
export interface ViewportPreset { width: number; height: number }
export interface FixedInsets { top: number | null; right: number | null; bottom: number | null; left: number | null }
export interface ParsedLayout {
  display: string;
  direction: 'HORIZONTAL' | 'VERTICAL' | 'NONE';
  reverse: boolean;
  justify: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  align: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
  stretch: boolean;
  gap: number;
  padding: Insets;
  margin: Insets;
  position: string;
  absolute: boolean; // Out of normal flow (absolute or fixed); position retains the CSS policy.
  grow: number;
  shrink: number;
  basis: string;
  zIndex: number | null;
  offsets: { top: string; right: string; bottom: string; left: string };
  fixedInsets?: FixedInsets; // CSS inset lengths resolved against the selected viewport, never the document.
  alignSelf: string;
  order: number;
  wrap: boolean;
  wrapSpacing?: number; // Native horizontal Wrap only, preserving the measured widths and CSS row gap.
  normalFlow?: { gap: number; padding: Insets; align: 'MIN' | 'CENTER' | 'MAX' }; // Verified block flow; margins are already included, without adding wrappers.
  contentComponent?: boolean; // Verified atomic text box; measured intrinsic widths remain safe Wrap inputs.
}
export interface ParsedSize {
  width: number;
  height: number;
  widthMode: SizingMode;
  heightMode: SizingMode;
  authoredWidth: string;
  authoredHeight: string;
  heightIntent?: HeightIntent;
  heightSource?: { renderedHeight: number; computedHeight: string; inlineHeight: string; minHeight: string; maxHeight: string;
    overflowX: string; overflowY: string; normalFlowChildren: boolean; reason?: string };
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
}
export interface ParsedImage { key: string; src: string; alt: string; fit: string; position?: string; repeat?: string; layerIndex?: number }
export interface ParsedGradient { angle: 0 | 90 | 180 | 270; stops: { position: number; color: Color }[]; layerIndex: number }
export type ParsedBackgroundLayer = { type: 'GRADIENT'; gradient: ParsedGradient } | { type: 'IMAGE'; image: ParsedImage } | { type: 'SOLID'; color: Color; layerIndex: number; base?: boolean };
export interface ParsedShadow { color: Color; x: number; y: number; blur: number; spread: number; inset: boolean }
export interface CSSVariableInfo { name: string; value: string; scope: string }
export interface ParsedStyle {
  background: Color | null;
  color: Color | null;
  borderWidths: Insets;
  borderColors: [Color | null, Color | null, Color | null, Color | null];
  radii: [number, number, number, number];
  opacity: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  lineHeight: number | null;
  letterSpacing: number;
  textAlign: string;
  textDecoration: string;
  whiteSpace: string;
  clipsContent: boolean;
  backgroundImage?: ParsedImage;
  backgroundGradient?: ParsedGradient;
  backgroundLayers?: ParsedBackgroundLayer[]; // CSS order: first layer is topmost, including the solid base last.
  backgroundGridFallback?: boolean; // Only full-box, repeated thin horizontal gradient lines.
  backgroundSource?: { background: string; backgroundImage: string; backgroundColor: string; backgroundSize: string; backgroundPosition: string };
  shadow?: ParsedShadow;
  textTransform?: string;
}
export type ParsedTextStyle = Pick<ParsedStyle, 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle' | 'color' | 'lineHeight' | 'letterSpacing' | 'textDecoration'>;
export interface ParsedTextRange { start: number; end: number; style: ParsedTextStyle }
export interface ParsedNode {
  type: 'FRAME' | 'TEXT' | 'IMAGE' | 'SVG';
  tagName: string;
  name: string;
  layerName?: string; // Presentation only; never used by layout/style conversion.
  text?: string;
  ranges?: ParsedTextRange[]; // UTF-16 offsets into the merged Text; empty means a uniform merged run.
  image?: ParsedImage;
  svg?: string;
  grid?: { columns: number[]; columnModes?: SizingMode[]; rowGap: number; columnGap: number; supported: boolean };
  source?: { selector: string; classNames: string[]; id: string; synthetic?: boolean; styleless?: boolean };
  cssVariables?: CSSVariableInfo[];
  rect: Bounds;
  layout: ParsedLayout;
  size: ParsedSize;
  style: ParsedStyle;
  children: ParsedNode[];
}
export interface ConversionWarning {
  code: string; node: string; message: string; category?: string; element?: string;
  detail?: Record<string, string | number>;
  occurrences?: number; // Repeated diagnostics retained without growing the raw list.
  locations?: string[]; // Bounded representative locations, never inferred from duplicate names.
}
export type WarningContext = Pick<ConversionWarning, 'element' | 'detail'>;
export type ReportWarningCode = 'EXTERNAL_RESOURCE' | 'UNSUPPORTED_STYLE' | 'FONT_FALLBACK' | 'IMAGE_ERROR' | 'SVG_ERROR' | 'SIZING_FALLBACK' | 'CONVERSION_WARNING';
export interface ReportWarning {
  code: ReportWarningCode;
  sourceCode: string;
  severity: 'warning';
  message: string;
  count: number;
  locations: string[];
  detail: Record<string, string | number>;
}
export interface ConversionOutcome {
  status: 'SUCCESS' | 'SUCCESS_WITH_WARNINGS' | 'ERROR';
  fileName: string;
  result: { frameCreated: boolean; frameCount: number };
  warningCount: number; // Distinct causes; occurrence counts are on each group.
  warningTypes: Partial<Record<ReportWarningCode, number>>;
  warnings: ReportWarning[];
  errorMessage?: string;
}
export interface ImportOptions { viewport: number; viewportHeight: number; autoLayout: boolean; styles: boolean; images?: boolean; shadows?: boolean; optimizeWrappers?: boolean; debug?: boolean }
export type LocalAssets = Record<string, string>;
export interface ParsedDocument {
  version: 1;
  root: ParsedNode;
  options: ImportOptions;
  assets: Record<string, number[]>;
  warnings: ConversionWarning[];
  cssVariables?: CSSVariableInfo[];
}
export interface ConversionReport {
  total: number;
  autoLayout: number;
  text: number;
  image: number;
  frames: number;
  grid: number;
  absolute: number;
  svg: number;
  durationMs: number;
  warningGroups: Record<string, number>;
  warnings: ConversionWarning[];
  heightHierarchy?: HeightHierarchyEntry[]; // Debug-only readback from the final Figma nodes, not parser predictions.
}
export interface HeightHierarchyEntry {
  id: string;
  parentId: string;
  path: string;
  name: string;
  source: string;
  marginWrapper: boolean;
  layoutMode: 'HORIZONTAL' | 'VERTICAL' | 'NONE' | 'GRID';
  heightMode: SizingMode;
  requestedHeightMode: SizingMode;
  primaryAxisSizingMode: 'FIXED' | 'AUTO';
  counterAxisSizingMode: 'FIXED' | 'AUTO';
  positioning: 'AUTO' | 'ABSOLUTE';
  height: number;
  y: number;
  width: number;
  minHeight: number | null;
  parsedReason: string;
  reason: string;
}
export type UIMessage = { type: 'CREATE_FIGMA'; requestId: string; fileName?: string; payload: ParsedDocument } | { type: 'CANCEL' };
export type ConversionStatus = 'idle' | 'converting' | 'success' | 'error';
export type MainMessage =
  | { type: 'PROGRESS'; requestId: string; count: number }
  | { type: 'CONVERSION_COMPLETE'; requestId: string; payload: { success: true; report: ConversionReport; outcome: ConversionOutcome } }
  | { type: 'CONVERSION_ERROR'; requestId: string; payload: { success: false; message: string; outcome: ConversionOutcome } };
export const LIMITS = { fileBytes: 5 * 1024 * 1024, imageBytes: 4 * 1024 * 1024, assetBytes: 16 * 1024 * 1024, nodes: 3000, depth: 80, loadMs: 8000, dimension: 100000 } as const;
export const VIEWPORT_PRESETS: Readonly<Record<string, Readonly<ViewportPreset>>> = {
  '1440': { width: 1440, height: 900 },
  '1280': { width: 1280, height: 800 },
  '768': { width: 768, height: 1024 },
  '375': { width: 375, height: 812 }
};
export const VIEWPORT = { ...VIEWPORT_PRESETS['1440']!, minDimension: 1, maxDimension: 10000 } as const;
export const IMPORT_DEFAULTS = { images: true, shadows: true, optimizeWrappers: true, debug: false } as const;

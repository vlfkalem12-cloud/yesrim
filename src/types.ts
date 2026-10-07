export type SizingMode = 'FIXED' | 'FILL' | 'HUG';
export interface Insets { top: number; right: number; bottom: number; left: number }
export interface Bounds { x: number; y: number; width: number; height: number }
export interface Color { r: number; g: number; b: number; a: number }
export interface ParsedLayout {
  display: string;
  direction: 'HORIZONTAL' | 'VERTICAL' | 'NONE';
  reverse: boolean;
  justify: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  align: 'MIN' | 'CENTER' | 'MAX';
  stretch: boolean;
  gap: number;
  padding: Insets;
  margin: Insets;
  position: string;
  absolute: boolean;
  grow: number;
  shrink: number;
  basis: string;
  zIndex: number | null;
  offsets: { top: string; right: string; bottom: string; left: string };
  alignSelf: string;
  order: number;
  wrap: boolean;
}
export interface ParsedSize {
  width: number;
  height: number;
  widthMode: SizingMode;
  heightMode: SizingMode;
  authoredWidth: string;
  authoredHeight: string;
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
}
export interface ParsedImage { key: string; src: string; alt: string; fit: string; position?: string; repeat?: string }
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
  shadow?: ParsedShadow;
  textTransform?: string;
}
export interface ParsedNode {
  type: 'FRAME' | 'TEXT' | 'IMAGE' | 'SVG';
  tagName: string;
  name: string;
  text?: string;
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
export interface ConversionWarning { code: string; node: string; message: string; category?: string; element?: string }
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
}
export type UIMessage = { type: 'CREATE_FIGMA'; requestId: string; payload: ParsedDocument } | { type: 'CANCEL' };
export type MainMessage =
  | { type: 'PROGRESS'; requestId: string; count: number }
  | { type: 'COMPLETE'; requestId: string; report: ConversionReport }
  | { type: 'ERROR'; requestId: string; message: string };
export const LIMITS = { fileBytes: 5 * 1024 * 1024, imageBytes: 4 * 1024 * 1024, assetBytes: 16 * 1024 * 1024, nodes: 3000, depth: 80, loadMs: 8000, dimension: 100000 } as const;
export const VIEWPORT = { width: 1440, height: 900, minDimension: 1, maxDimension: 10000 } as const;
export const IMPORT_DEFAULTS = { images: true, shadows: true, optimizeWrappers: true, debug: false } as const;

import type { ParsedNode, SizingMode } from './types';
import { number } from './utils';
import { authoredDimension } from './sizing';

/** The browser resolves repeat()/fr into track px. Only simple, sequential, unspanned rows qualify. */
export function parseGrid(node: ParsedNode, style: CSSStyleDeclaration, element: Element, warn: (code: string, name: string, message: string) => void): void {
  const columns = style.gridTemplateColumns.split(/\s+/).filter(Boolean);
  const declared = authoredDimension(element, 'grid-template-columns').trim();
  const repeat = declared.match(/^repeat\(\s*(\d+)\s*,\s*1fr\s*\)$/);
  const tracks = repeat && Number(repeat[1]) <= 12 ? Array(Number(repeat[1])).fill('1fr') as string[] : declared.split(/\s+/);
  const supportedTracks = tracks.length === columns.length && tracks.every(track => track === '1fr' || /^\d+(?:\.\d+)?px$/.test(track));
  const children = [...element.children].filter(child => {
    const css = element.ownerDocument.defaultView!.getComputedStyle(child);
    return css.display !== 'none' && css.visibility !== 'hidden' && !['absolute', 'fixed'].includes(css.position);
  });
  const simple = supportedTracks && columns.length > 0 && columns.length <= 12 && columns.every(track => /^\d+(?:\.\d+)?px$/.test(track)) &&
    !style.gridAutoFlow.includes('column') && !style.gridAutoFlow.includes('dense') && children.every(child => {
      const css = element.ownerDocument.defaultView!.getComputedStyle(child);
      return [css.gridColumnStart, css.gridColumnEnd, css.gridRowStart, css.gridRowEnd].every(value => value === 'auto') && css.order === '0';
    });
  node.grid = { columns: columns.map(track => number(track)), columnModes: tracks.map(track => track === '1fr' ? 'FILL' : 'FIXED') as SizingMode[], rowGap: number(style.rowGap), columnGap: number(style.columnGap), supported: simple };
  if (!simple) {
    node.layout.direction = 'NONE'; node.size.widthMode = 'FIXED'; node.size.heightMode = 'FIXED';
    warn('GRID_FALLBACK', node.name, 'Grid의 span·명시적 placement·dense·복잡한 track은 측정한 고정 Frame으로 유지합니다.');
  }
}

/** Convert supported grids to vertical rows of horizontal cell frames, without absolute grid cells. */
export function buildGridRows(node: ParsedNode): void {
  if (!node.grid?.supported) return;
  const { columns, rowGap, columnGap } = node.grid;
  const flow = node.children.filter(child => !child.layout.absolute);
  const absolute = node.children.filter(child => child.layout.absolute);
  const rows: ParsedNode[] = [];
  for (let start = 0; start < flow.length; start += columns.length) {
    const items = flow.slice(start, start + columns.length);
    const top = Math.min(...items.map(child => child.rect.y - Math.max(0, child.layout.margin.top)));
    const rowHeight = Math.max(...items.map(child => child.rect.height + Math.max(0, child.layout.margin.top) + Math.max(0, child.layout.margin.bottom)));
    const rowWidth = columns.reduce((a, b) => a + b, 0) + columnGap * (columns.length - 1);
    const first = items[0]!;
    const row: ParsedNode = { ...node, name: `${node.name} / row ${rows.length + 1}`, grid: undefined, cssVariables: [],
      source: { selector: `${node.source?.selector || node.name} / row`, id: '', classNames: [], synthetic: true },
      rect: { x: first.rect.x - Math.max(0, first.layout.margin.left), y: top, width: rowWidth, height: rowHeight },
      size: { width: rowWidth, height: rowHeight, authoredWidth: '100%', authoredHeight: 'auto', widthMode: 'FILL', heightMode: 'FIXED' },
      layout: { ...node.layout, display: 'flex', direction: 'HORIZONTAL', gap: columnGap, reverse: false, justify: 'MIN', align: 'MIN',
        padding: { top: 0, right: 0, bottom: 0, left: 0 }, margin: { top: 0, right: 0, bottom: 0, left: 0 }, absolute: false, grow: 0, zIndex: null },
      style: { ...node.style, opacity: 1, background: null, backgroundImage: undefined, backgroundGradient: undefined, backgroundLayers: undefined, shadow: undefined, clipsContent: false, borderWidths: { top: 0, right: 0, bottom: 0, left: 0 }, radii: [0, 0, 0, 0] }, children: [] };
    row.children = columns.map((width, index) => {
      const child = items[index];
      const cell: ParsedNode = { ...row, name: child ? `${child.name} / cell` : `${node.name} / empty cell ${index + 1}`,
        source: { selector: `${child?.source?.selector || child?.name || node.name} / cell`, id: '', classNames: [], synthetic: true },
        rect: { x: row.rect.x + columns.slice(0, index).reduce((a, b) => a + b, 0) + columnGap * index, y: top, width, height: rowHeight },
        size: { width, height: rowHeight, authoredWidth: `${width}px`, authoredHeight: `${rowHeight}px`, widthMode: node.grid!.columnModes?.[index] || 'FIXED', heightMode: 'FIXED' },
        layout: { ...row.layout, direction: 'VERTICAL', gap: 0 }, children: child ? [child] : [] };
      // A grid stretch item is now a child of a vertical cell.
      if (child && (child.size.authoredWidth === 'auto' || child.size.authoredWidth === '100%')) child.size.widthMode = 'FILL';
      if (child && child.size.authoredHeight === 'auto' && child.rect.height >= rowHeight - 1 && !Object.values(child.layout.margin).some(v => v)) child.size.heightMode = 'FILL';
      return cell;
    });
    rows.push(row);
  }
  node.layout.direction = 'VERTICAL'; node.layout.gap = rowGap; node.layout.align = 'MIN'; node.layout.justify = 'MIN';
  node.layout.reverse = false; node.layout.wrap = false;
  node.children = [...rows, ...absolute];
}

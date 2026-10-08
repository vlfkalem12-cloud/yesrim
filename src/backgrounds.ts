import type { Color, ParsedBackgroundLayer, ParsedStyle } from './types';

/** Include the solid base exactly once, retaining compatibility with older version-1 JSON. */
export function backgroundLayers(style: ParsedStyle): ParsedBackgroundLayer[] {
  const legacy: ParsedBackgroundLayer[] = [
    ...(style.backgroundGradient ? [{ type: 'GRADIENT' as const, gradient: style.backgroundGradient }] : []),
    ...(style.backgroundImage ? [{ type: 'IMAGE' as const, image: style.backgroundImage }] : [])
  ];
  const indexOf = (layer: ParsedBackgroundLayer) => layer.type === 'GRADIENT' ? layer.gradient.layerIndex : layer.type === 'IMAGE' ? layer.image.layerIndex ?? 0 : layer.layerIndex;
  const layers = style.backgroundLayers ?? legacy.sort((a, b) => indexOf(a) - indexOf(b));
  if (!style.background || layers.some(layer => layer.type === 'SOLID' && layer.base)) return layers;
  return [...layers, { type: 'SOLID', color: style.background, layerIndex: Math.max(-1, ...layers.map(indexOf)) + 1, base: true }];
}

export interface BackgroundGridLine { position: number; color: Color; layerIndex: number }

/** Deliberately narrow: at least three evenly spaced, same-color, <=2% transparent/peak/transparent bands. */
export function thinHorizontalGridLines(layers: ParsedBackgroundLayer[]): BackgroundGridLine[] | null {
  const gradients = layers.filter(layer => !(layer.type === 'SOLID' && layer.base));
  if (gradients.length < 3) return null;
  const lines: BackgroundGridLine[] = [];
  let angle: number | undefined;
  for (const layer of gradients) {
    if (layer.type !== 'GRADIENT') return null;
    const gradient = layer.gradient;
    if (![0, 180].includes(gradient.angle) || (angle !== undefined && angle !== gradient.angle) || gradient.stops.length !== 3) return null;
    angle = gradient.angle;
    const [before, peak, after] = gradient.stops;
    if (!before || !peak || !after || before.color.a !== 0 || after.color.a !== 0 || peak.color.a <= 0 ||
      before.position >= peak.position || peak.position >= after.position || after.position - before.position > .020001 ||
      Math.abs((peak.position - before.position) - (after.position - peak.position)) > .000001) return null;
    const position = angle === 180 ? peak.position : 1 - peak.position;
    lines.push({ position, color: peak.color, layerIndex: gradient.layerIndex });
  }
  lines.sort((a, b) => a.position - b.position);
  const color = lines[0]!.color, spacing = lines[1]!.position - lines[0]!.position;
  if (spacing <= .02 || lines.some((line, index) =>
    ['r', 'g', 'b', 'a'].some(channel => Math.abs(line.color[channel as keyof Color] - color[channel as keyof Color]) > .000001) ||
    (index > 0 && Math.abs(line.position - lines[index - 1]!.position - spacing) > .000001))) return null;
  return lines;
}

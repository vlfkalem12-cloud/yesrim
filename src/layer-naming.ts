import type { ParsedNode } from './types';

const NAME_LIMIT = 40, TEXT_LIMIT = 30;
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const clip = (value: string, limit = NAME_LIMIT) => {
  const characters = [...normalize(value)];
  return characters.length <= limit ? characters.join('') : characters.slice(0, limit - 1).join('').trimEnd() + '…';
};
const words = (value: string) => normalize(value.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' '));
const readable = (value: string) => words(value).split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
const meaningful = (value: string) => /\p{L}/u.test(value) && !/^(?:undefined|null|true|false|none)$/i.test(value);
const shortText = (value: string) => {
  const text = normalize(value);
  return meaningful(text) && [...text].length <= TEXT_LIMIT && (text.match(/[.!?。！？]/g)?.length || 0) <= 1 ? text : '';
};
const meaningfulIdentifier = (value: string) => meaningful(value) && !/^(?:[\da-f]{8,}|(?:id|node|element)[_-]?\d+|(?:css|jsx|sc)[_-][\da-z]+)$/i.test(value);

/** Component classes remain candidates; Bootstrap/Tailwind layout and appearance utilities do not. */
export function isUtilityClass(value: string): boolean {
  if (/[\[\]]/.test(value)) return true;
  const token = value.split(':').pop()!.replace(/^!/, '').replace(/^-/, '');
  return /^(?:flex|inline-flex|block|inline|inline-block|grid|inline-grid|hidden|contents|relative|absolute|fixed|sticky|static|row|col|container|container-fluid|clearfix|sr-only|not-sr-only|visually-hidden|antialiased|subpixel-antialiased|truncate|grow|shrink|italic|not-italic|underline|no-underline|uppercase|lowercase|capitalize|normal-case|overflow-hidden|rounded|shadow|border)$/i.test(token) ||
    /^(?:d|display|flex|align|justify|items|self|place|order|gap|space|col|row|g|gx|gy|p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|w|h|min-w|max-w|min-h|max-h|text|bg|font|leading|tracking|border|rounded|opacity|object|position|top|right|bottom|left|inset|z|float|clear|visible|invisible|cursor|pointer-events|select|outline|ring|fill|stroke|transition|duration|ease|delay|animate|translate|rotate|scale|skew|origin|basis|grow|shrink|whitespace|break|decoration)-/i.test(token) ||
    /^(?:content-(?:start|end|center|between|around|evenly|baseline|normal|stretch)|grid-(?:cols|rows|flow)-[\w-]+|overflow-(?:[xy]-)?(?:auto|hidden|clip|visible|scroll)|shadow-(?:sm|md|lg|xl|2xl|inner|none)|list-(?:none|disc|decimal|inside|outside)|table-(?:auto|fixed))$/i.test(token) ||
    /^(?:ng-scope|ng-star-inserted|js-|is-|has-|css-|jsx-|sc-)/i.test(token);
}

const semantics: Record<string, string> = {
  header: 'Header', nav: 'Navigation', main: 'Main', aside: 'Sidebar', footer: 'Footer', form: 'Form',
  table: 'Table', thead: 'Table Header', tbody: 'Table Body', tfoot: 'Table Footer', tr: 'Table Row', th: 'Table Header Cell', td: 'Table Cell',
  ul: 'List', ol: 'List', li: 'List Item', button: 'Button', input: 'Input', select: 'Select', textarea: 'Textarea',
  section: 'Section', article: 'Article', a: 'Link', label: 'Label', h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading'
};
const roles: Record<string, string> = {
  navigation: 'Navigation', main: 'Main', complementary: 'Sidebar', banner: 'Header', contentinfo: 'Footer',
  form: 'Form', dialog: 'Dialog', alert: 'Alert', status: 'Status', toolbar: 'Toolbar', tablist: 'Tabs', tab: 'Tab',
  list: 'List', listitem: 'List Item', group: 'Group', region: 'Section', button: 'Button', checkbox: 'Checkbox', radio: 'Radio',
  textbox: 'Input', img: 'Image', table: 'Table', row: 'Table Row', cell: 'Table Cell', columnheader: 'Column Header', rowheader: 'Row Header'
};
function structure(value: string): string {
  const tokens = words(value).toLowerCase().split(' ');
  if (tokens.includes('button') && tokens.includes('group')) return 'Button Group';
  for (const [token, name] of Object.entries({ card: 'Card', widget: 'Widget', modal: 'Modal', dialog: 'Dialog', toolbar: 'Toolbar', tabs: 'Tabs', tab: 'Tab', sidebar: 'Sidebar', navigation: 'Navigation', content: 'Content', section: 'Section', list: 'List', table: 'Table', badge: 'Badge' })) {
    if (tokens.includes(token)) return name;
  }
  return '';
}

export interface LayerNamingContext {
  type: ParsedNode['type']; text?: string; width?: number; height?: number;
  isHidden?: (element: Element) => boolean;
  debug?: (candidates: Record<string, unknown>) => void;
}

/** Reads DOM metadata only. It never changes the DOM, styles, geometry or the parsed layout. */
export function generateLayerName(element: Element, context: LayerNamingContext): string {
  const tag = element.localName;
  const aria = normalize(element.getAttribute('aria-label') || '');
  const id = meaningfulIdentifier(element.id) ? element.id : '';
  const classes = [...element.classList].filter(name => !isUtilityClass(name) && meaningfulIdentifier(name));
  const componentClass = classes.find(name => !!structure(name)) || classes[0] || '';
  const role = element.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase() || '';
  const content = (parent: Element, skipHidden = true): string => {
    if (skipHidden && context.isHidden?.(parent)) return '';
    if (['svg', 'script', 'style', 'input', 'textarea', 'select', 'option', 'title', 'desc'].includes(parent.localName)) return '';
    return [...parent.childNodes].map(child => child.nodeType === 3 ? child.textContent || '' : child.nodeType === 1 ? content(child as Element, skipHidden) : '').join(' ');
  };
  const ownText = () => shortText(content(element));
  const heading = [...element.children].find(child => /^h[1-6]$/.test(child.localName)) ||
    [...element.children].filter(child => child.localName === 'header' || /(?:^|[-_])header(?:$|[-_\s])/.test(`${child.id} ${child.getAttribute('class') || ''}`)).flatMap(child => [...child.children]).find(child => /^h[1-6]$/.test(child.localName));
  // A navigation/list's first item is not its title. Inline labels represent small components
  // (cards, widgets, badges, tabs), or a container with just one visible child.
  const inlineLabel = [...element.children].filter(child => !context.isHidden?.(child)).length === 1 ||
    [structure(id), structure(componentClass)].some(name => ['Card', 'Widget', 'Badge', 'Tab'].includes(name));
  const representative = (heading ? shortText(content(heading)) : '') ||
    shortText([...element.childNodes].filter(child => child.nodeType === 3).map(child => child.textContent || '').join(' ')) ||
    (inlineLabel ? [...element.children].filter(child => ['span', 'strong', 'b', 'em', 'small'].includes(child.localName)).map(child => shortText(content(child))).find(Boolean) : '') || '';
  const control = tag === 'input' ? (element as HTMLInputElement).type.toLowerCase() : tag;
  const controlName = control === 'checkbox' ? 'Checkbox' : control === 'radio' ? 'Radio' : ['button', 'submit', 'reset'].includes(control) ? 'Button' : semantics[tag];
  const labels = ['input', 'select', 'textarea'].includes(tag) ? [...((element as HTMLInputElement).labels || [])].map(label => shortText(content(label, false))).find(Boolean) || '' : '';
  const category = structure(id) || structure(componentClass) || semantics[tag] || '';
  const finish = (value: string, reason: string): string => {
    const final = clip(value);
    context.debug?.({ tag, ariaLabel: aria, id: element.id, class: [...element.classList], meaningfulClass: componentClass, role, label: labels, text: representative, reason, final });
    return final;
  };
  // Pure text keeps its displayed content; accessibility/box names belong to the enclosing Frame.
  if (context.type === 'TEXT') return finish(context.text ? textLayerName(context.text) : clip(ownText() || 'Text'), 'text');
  if (tag === 'svg') {
    const title = normalize(element.querySelector(':scope > title')?.textContent || '');
    const own = `${element.id} ${classes.join(' ')} ${title}`;
    const parent = `${element.parentElement?.id || ''} ${element.parentElement?.getAttribute('class') || ''}`;
    const chartWords = /(?:chart|graph|plot|donut|sparkline)/i;
    const chart = chartWords.test(own) || ((context.width || 0) >= 160 && (context.height || 0) >= 80) ||
      (!/icon/i.test(own) && chartWords.test(parent) && (context.width || 0) > 80 && (context.height || 0) > 40);
    const prefix = chart ? 'Chart' : 'Icon';
    const hint = meaningful(aria) ? readable(aria) : meaningful(title) ? readable(title) : id ? readable(id) : componentClass ? readable(componentClass) : '';
    const detail = normalize(hint.replace(new RegExp(`(?:^${prefix}\\s*|\\s*${prefix}$)`, 'gi'), ''));
    return finish(detail ? `${prefix} / ${detail}` : prefix, 'svg');
  }
  if (meaningful(aria)) return finish(readable(aria), 'aria-label');
  if (tag === 'img') {
    const alt = normalize(element.getAttribute('alt') || '');
    return finish(meaningful(alt) ? `Image / ${readable(alt)}` : 'Image', 'alt');
  }
  if (['input', 'select', 'textarea'].includes(tag)) {
    if (labels) return finish(`${controlName} / ${labels}`, 'label');
    if (tag === 'input' && controlName === 'Button') {
      const value = shortText((element as HTMLInputElement).value);
      if (value) return finish(`Button / ${value}`, 'button text');
    }
  }
  const title = ['button', 'a', 'li'].includes(tag) ? ownText() : representative;
  if (category && title) return finish(`${category} / ${title}`, 'semantic text');
  if (id) return finish(readable(id), 'id');
  if (componentClass) return finish(componentClass === tag && semantics[tag] ? controlName || semantics[tag]! : readable(componentClass), 'class');
  if (roles[role]) return finish(title ? `${roles[role]} / ${title}` : roles[role]!, 'role');
  if (['input', 'select', 'textarea'].includes(tag)) return finish(controlName || 'Input', 'control');
  if (semantics[tag]) return finish(semantics[tag]!, 'semantic tag');
  const fallback = tag === 'body' || tag === 'html' ? 'Imported HTML' : tag === 'div' ? 'Container' : tag === 'span' ? 'Text Container' : tag === 'p' ? 'Paragraph' : readable(tag);
  return finish(title && !['body', 'html', 'p'].includes(tag) ? `${fallback} / ${title}` : fallback, 'tag');
}

export const textLayerName = (text: string): string => clip(text || 'Text');

/** Synthetic rows/cells have no corresponding DOM element. Their existing structure stays intact. */
export function parsedLayerName(node: ParsedNode): string {
  if (node.type === 'TEXT') return textLayerName(node.text || 'Text');
  if (node.layerName) return node.layerName;
  if (node.source?.synthetic && node.source.selector.endsWith(' / row')) return 'Grid Row';
  if (node.source?.synthetic && node.source.selector.endsWith(' / cell')) return node.children[0] ? clip(`Grid Cell / ${parsedLayerName(node.children[0])}`) : 'Grid Cell';
  return node.name;
}

export function applyLayerNames(assignments: { node: SceneNode; parsed: ParsedNode; margin?: boolean }[], debug: boolean): void {
  for (const { node, parsed, margin } of assignments) if (!node.removed) {
    const base = margin ? clip(`${parsedLayerName(parsed)} / Margin`) : parsedLayerName(parsed);
    node.name = debug && parsed.source ? `${base} [${parsed.source.selector}${margin ? ' / margin' : ''}]` : base;
  }
}

import type { Bounds } from './types';
import { number, readInsets } from './utils';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number']);
export interface FormContent { text: string; placeholder: boolean; multiline: boolean }

/** Native controls render their current state outside the element's DOM text children. */
export function readFormContent(element: Element): FormContent | null {
  if (element.localName === 'select') {
    const select = element as HTMLSelectElement;
    return { text: select.selectedOptions[0]?.label ?? '', placeholder: false, multiline: false };
  }
  if (element.localName !== 'input' && element.localName !== 'textarea') return null;
  const control = element as HTMLInputElement | HTMLTextAreaElement;
  if (element.localName === 'input' && !TEXT_INPUT_TYPES.has((control as HTMLInputElement).type)) return null;
  return { text: control.value || control.placeholder || '', placeholder: !control.value && !!control.placeholder, multiline: element.localName === 'textarea' };
}

/** A hidden text mirror measures native content, for which DOM Range has no text to select. */
export function measureFormText(element: Element, rect: Bounds, style: CSSStyleDeclaration, content: FormContent): Bounds {
  const doc = element.ownerDocument;
  const controlStyle = doc.defaultView!.getComputedStyle(element);
  const border = readInsets(controlStyle, 'border'), padding = readInsets(controlStyle, 'padding');
  const width = Math.max(1, rect.width - border.left - border.right - padding.left - padding.right);
  const height = Math.max(0, rect.height - border.top - border.bottom - padding.top - padding.bottom);
  const mirror = doc.createElement('span');
  mirror.style.setProperty('all', 'initial', 'important');
  for (const key of ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'direction', 'word-break', 'overflow-wrap', 'tab-size']) mirror.style.setProperty(key, style.getPropertyValue(key), 'important');
  for (const [key, value] of Object.entries({ position: 'fixed', left: '0', top: '0', display: 'block', width: `${width}px`, height: 'auto', visibility: 'hidden', 'white-space': content.multiline ? controlStyle.whiteSpace : 'pre' })) mirror.style.setProperty(key, value, 'important');
  mirror.textContent = content.text;
  doc.body.append(mirror);
  try {
    const range = doc.createRange(); range.selectNodeContents(mirror);
    const box = range.getBoundingClientRect(), lineBox = mirror.getBoundingClientRect();
    const verticalOffset = content.multiline ? 0 : Math.max(0, (height - lineBox.height) / 2);
    return {
      x: rect.x + border.left + padding.left + (content.multiline ? 0 : box.x - lineBox.x),
      y: rect.y + border.top + padding.top + verticalOffset + box.y - lineBox.y,
      width: content.multiline ? width : box.width,
      height: Math.max(box.height, number(style.lineHeight, number(style.fontSize, 16)))
    };
  } finally { mirror.remove(); }
}

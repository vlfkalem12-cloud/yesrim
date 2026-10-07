import { parseHTML } from './parser';
import { LIMITS, VIEWPORT, type ConversionReport, type MainMessage, type ParsedDocument, type UIMessage } from './types';
import { errorMessage, isViewportDimension } from './utils';

function get<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
}
const input = get<HTMLInputElement>('file');
const dropzone = get<HTMLLabelElement>('dropzone');
const convert = get<HTMLButtonElement>('convert');
const cancel = get<HTMLButtonElement>('cancel');
const json = get<HTMLButtonElement>('json');
const viewport = get<HTMLSelectElement>('viewport');
const viewportWidth = get<HTMLInputElement>('viewport-width');
const viewportHeight = get<HTMLInputElement>('viewport-height');
const autoLayout = get<HTMLInputElement>('autolayout');
const styles = get<HTMLInputElement>('styles');
let html: string | null = null;
let parsed: ParsedDocument | null = null;
let busy = false;
let cancelled = false;
let requestId = '';

const send = (message: UIMessage) => parent.postMessage({ pluginMessage: message }, '*');
function status(message: string, state = ''): void { const element = get('status'); element.textContent = message; element.dataset.state = state; }
function validateViewport(): boolean {
  const widthValid = isViewportDimension(viewportWidth.valueAsNumber);
  const heightValid = isViewportDimension(viewportHeight.valueAsNumber);
  viewportWidth.setAttribute('aria-invalid', String(!widthValid));
  viewportHeight.setAttribute('aria-invalid', String(!heightValid));
  get('viewport-error').hidden = widthValid && heightValid;
  convert.disabled = busy || html === null || !widthValid || !heightValid;
  return widthValid && heightValid;
}
viewport.addEventListener('change', () => {
  if (viewport.value !== 'custom') {
    viewportWidth.value = viewport.value;
    viewportHeight.value = String(VIEWPORT.height);
  }
  validateViewport();
});
for (const field of [viewportWidth, viewportHeight]) field.addEventListener('input', () => {
  viewport.value = viewportHeight.valueAsNumber === VIEWPORT.height && ['1440', '1280', '768', '375'].includes(viewportWidth.value) ? viewportWidth.value : 'custom';
  validateViewport();
});
function setBusy(value: boolean): void {
  busy = value;
  validateViewport();
  input.disabled = viewport.disabled = viewportWidth.disabled = viewportHeight.disabled = autoLayout.disabled = styles.disabled = value;
  dropzone.setAttribute('aria-disabled', String(value));
  cancel.hidden = !value;
  if (!value) cancel.disabled = false;
  convert.textContent = value ? '변환 중…' : 'Figma로 변환';
}
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('HTML 파일을 읽을 수 없습니다.'));
    reader.onerror = () => reject(new Error('파일 읽기에 실패했습니다.'));
    reader.onabort = () => reject(new Error('파일 읽기가 취소되었습니다.'));
    reader.readAsText(file);
  });
}
async function selectFile(file: File | undefined): Promise<void> {
  if (busy || !file) return;
  cancelled = false;
  if (!/\.html?$/i.test(file.name)) { status('.html 또는 .htm 파일을 선택하세요.', 'error'); return; }
  if (file.size > LIMITS.fileBytes) { status('파일이 5MB 제한을 초과했습니다.', 'error'); return; }
  html = null; parsed = null; json.hidden = true; get('report').hidden = true;
  setBusy(true); status('HTML 파일을 읽고 있습니다.');
  try {
    const content = await readFile(file);
    if (cancelled) return;
    if (!content.trim()) throw new Error('HTML 파일이 비어 있습니다.');
    html = content;
    get('filename').textContent = file.name;
    get('fileinfo').textContent = `${(file.size / 1024).toFixed(1)} KB · 다른 파일을 선택하려면 클릭`;
    status('준비되었습니다. Viewport를 설정하고 변환하세요.');
  } catch (error) { status(errorMessage(error), 'error'); }
  finally { cancelled = false; setBusy(false); input.value = ''; }
}
input.addEventListener('change', () => { void selectFile(input.files?.[0]); });
dropzone.addEventListener('keydown', event => { if (!busy && ['Enter', ' '].includes(event.key)) { event.preventDefault(); input.click(); } });
dropzone.addEventListener('click', event => { if (busy) event.preventDefault(); });
for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, event => { event.preventDefault(); if (!busy) dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('drag'); void selectFile(event.dataTransfer?.files[0]); });
// Avoid browser navigation if a file misses the upload target.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());

convert.addEventListener('click', async () => {
  if (busy || html === null) return;
  if (!validateViewport()) return;
  requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  cancelled = false; parsed = null; setBusy(true); get('report').hidden = true; json.hidden = true;
  status('HTML을 렌더링하고 레이아웃을 분석합니다…');
  try {
    parsed = await parseHTML(html, { viewport: viewportWidth.valueAsNumber, viewportHeight: viewportHeight.valueAsNumber, autoLayout: autoLayout.checked, styles: styles.checked }, get('render-host'));
    if (cancelled) { status('변환을 취소했습니다.'); setBusy(false); return; }
    console.info('HTML → Figma intermediate document', parsed);
    json.hidden = false;
    status('Figma 레이어를 생성합니다…');
    send({ type: 'CREATE_FIGMA', requestId, payload: parsed });
  } catch (error) { status(errorMessage(error), 'error'); setBusy(false); }
});
cancel.addEventListener('click', () => { cancelled = true; send({ type: 'CANCEL' }); status('변환을 취소하고 있습니다…'); cancel.disabled = true; });
json.addEventListener('click', () => {
  if (!parsed) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(parsed, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'html-to-figma.json'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function showReport(report: ConversionReport): void {
  get('report').hidden = false;
  for (const [id, value] of [['total-count', report.total], ['layout-count', report.autoLayout], ['text-count', report.text], ['image-count', report.image]] as const) get(id).textContent = String(value);
  get('warning-summary').textContent = `Warning ${report.warnings.length}`;
  const list = get('warnings'); list.replaceChildren();
  const groups = new Map<string, number>();
  for (const warning of report.warnings) groups.set(warning.code, (groups.get(warning.code) ?? 0) + 1);
  for (const [code, count] of groups) { const li = document.createElement('li'); li.textContent = `${code}: ${count}`; list.append(li); }
  for (const warning of report.warnings) { const li = document.createElement('li'); li.textContent = `${warning.node} — ${warning.message}`; list.append(li); }
  get('warning-details').hidden = report.warnings.length === 0;
}
window.addEventListener('message', (event: MessageEvent<{ pluginMessage?: MainMessage }>) => {
  if (event.source !== parent) return;
  const message = event.data?.pluginMessage;
  if (!message || message.requestId !== requestId || !busy) return;
  if (message.type === 'PROGRESS') { status(`${message.count}개의 레이어를 생성했습니다…`); return; }
  if (message.type === 'COMPLETE') { showReport(message.report); status('변환 완료 · Figma 캔버스에서 레이어를 편집하세요.', 'success'); }
  else if (message.type === 'ERROR') status(message.message, 'error');
  else return;
  cancel.disabled = false; setBusy(false);
});

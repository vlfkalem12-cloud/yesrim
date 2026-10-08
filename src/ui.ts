import { parseHTML } from './parser';
import { LIMITS, VIEWPORT_PRESETS, type ConversionOutcome, type ConversionReport, type ConversionStatus, type LocalAssets, type MainMessage, type ParsedDocument, type UIMessage } from './types';
import { errorMessage, isViewportDimension } from './utils';
import { failedOutcome, REPORT_LABELS, reportText } from './report';

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
const images = get<HTMLInputElement>('images');
const shadows = get<HTMLInputElement>('shadows');
const optimize = get<HTMLInputElement>('optimize');
const debug = get<HTMLInputElement>('debug');
const assetFiles = get<HTMLInputElement>('asset-files');
let localAssets: LocalAssets = {};
let html: string | null = null;
let parsed: ParsedDocument | null = null;
let conversionStatus: ConversionStatus = 'idle';
let readingFiles = false;
let cancelled = false;
let requestId: string | null = null;
let selectedFileName = '';

const send = (message: UIMessage) => parent.postMessage({ pluginMessage: message }, '*');
const isBusy = () => conversionStatus === 'converting' || readingFiles;
function status(message: string, state: ConversionStatus = conversionStatus): void {
  conversionStatus = state;
  const element = get('status'); element.textContent = message; element.dataset.state = state;
}
function validateViewport(): boolean {
  const widthValid = isViewportDimension(viewportWidth.valueAsNumber);
  const heightValid = isViewportDimension(viewportHeight.valueAsNumber);
  viewportWidth.setAttribute('aria-invalid', String(!widthValid));
  viewportHeight.setAttribute('aria-invalid', String(!heightValid));
  get('viewport-error').hidden = widthValid && heightValid;
  convert.disabled = isBusy() || html === null || !widthValid || !heightValid;
  return widthValid && heightValid;
}
viewport.addEventListener('change', () => {
  const preset = VIEWPORT_PRESETS[viewport.value];
  if (preset) {
    viewportWidth.value = String(preset.width);
    viewportHeight.value = String(preset.height);
  }
  validateViewport();
});
for (const field of [viewportWidth, viewportHeight]) field.addEventListener('input', () => {
  viewport.value = Object.entries(VIEWPORT_PRESETS).find(([, preset]) => preset.width === viewportWidth.valueAsNumber && preset.height === viewportHeight.valueAsNumber)?.[0] || 'custom';
  validateViewport();
});
function renderControls(): void {
  const value = isBusy();
  validateViewport();
  input.disabled = viewport.disabled = viewportWidth.disabled = viewportHeight.disabled = autoLayout.disabled = styles.disabled = value;
  images.disabled = shadows.disabled = optimize.disabled = debug.disabled = assetFiles.disabled = value;
  dropzone.setAttribute('aria-disabled', String(value));
  cancel.hidden = !value;
  if (!value) cancel.disabled = false;
  convert.textContent = conversionStatus === 'converting' ? '변환 중…' : 'Figma로 변환';
}
function finishConversion(state: 'success' | 'error', message: string, report?: ConversionReport, outcome?: ConversionOutcome): void {
  requestId = null; cancelled = false;
  input.value = ''; dropzone.classList.remove('drag');
  status(message, state);
  try { showReport(report, outcome || failedOutcome(selectedFileName, message)); }
  catch (error) {
    get('report').hidden = true;
    console.warn('Conversion report display failed', error);
    status(`${message} 보고서를 표시하지 못했습니다. Figma에서 결과를 확인해 주세요.`, state);
  } finally { renderControls(); }
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
  if (isBusy() || !file) return;
  cancelled = false; requestId = null; input.value = '';
  html = null; parsed = null; json.hidden = true; get('report').hidden = true;
  selectedFileName = file.name; renderControls();
  if (!/\.html?$/i.test(file.name)) { status('.html 또는 .htm 파일을 선택하세요.', 'error'); return; }
  if (file.size > LIMITS.fileBytes) { status('파일이 5MB 제한을 초과했습니다.', 'error'); return; }
  readingFiles = true; status('HTML 파일을 읽고 있습니다.', 'idle'); renderControls();
  try {
    const content = await readFile(file);
    if (cancelled) return;
    if (!content.trim()) throw new Error('HTML 파일이 비어 있습니다.');
    html = content;
    get('filename').textContent = file.name;
    get('fileinfo').textContent = `${(file.size / 1024).toFixed(1)} KB · 다른 파일을 선택하려면 클릭`;
    status('준비되었습니다. Viewport를 설정하고 변환하세요.');
  } catch (error) { status(errorMessage(error), 'error'); }
  finally {
    if (cancelled) status('파일 선택을 취소했습니다.', 'idle');
    cancelled = false; readingFiles = false; renderControls(); input.value = '';
  }
}
input.addEventListener('change', () => { void selectFile(input.files?.[0]); });
assetFiles.addEventListener('change', async () => {
  if (isBusy() || !assetFiles.files?.length) return;
  const files = [...assetFiles.files];
  if (files.length > 100 || files.some(file => file.size > LIMITS.imageBytes) || files.reduce((sum, file) => sum + file.size, 0) > LIMITS.assetBytes) { status('이미지는 파일당 4MB, 총 16MB, 최대 100개까지 추가할 수 있습니다.', 'error'); return; }
  cancelled = false; readingFiles = true; status('이미지를 읽고 있습니다.', 'idle'); renderControls();
  try {
    const entries = await Promise.all(files.map(async file => {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('이미지 읽기 실패')); reader.onerror = () => reject(new Error('이미지 읽기 실패')); reader.readAsDataURL(file);
      });
      if (!/^data:image\//i.test(data)) throw new Error(`${file.name}은 지원하는 이미지 파일이 아닙니다.`);
      return { path: file.webkitRelativePath || file.name, basename: file.name, data };
    }));
    if (cancelled) return;
    localAssets = {};
    const duplicates = new Set(entries.filter(entry => entries.filter(other => other.basename === entry.basename).length > 1).map(entry => entry.basename));
    for (const entry of entries) { if (!duplicates.has(entry.path)) localAssets[entry.path] = entry.data; if (!duplicates.has(entry.basename)) localAssets[entry.basename] = entry.data; }
    get('asset-count').textContent = `${files.length}개 선택`;
    status(duplicates.size ? `이름이 중복된 이미지 ${[...duplicates].join(', ')}는 경로가 일치할 때만 사용합니다.` : '이미지를 추가했습니다. HTML 변환 시 상대 경로에 적용합니다.');
  } catch (error) { status(errorMessage(error), 'error'); }
  finally {
    if (cancelled) status('이미지 선택을 취소했습니다.', 'idle');
    cancelled = false; readingFiles = false; renderControls(); assetFiles.value = '';
  }
});
dropzone.addEventListener('keydown', event => { if (!isBusy() && ['Enter', ' '].includes(event.key)) { event.preventDefault(); input.value = ''; input.click(); } });
dropzone.addEventListener('click', event => { if (isBusy()) event.preventDefault(); });
for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, event => { event.preventDefault(); if (!isBusy()) dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('drag'); void selectFile(event.dataTransfer?.files[0]); });
// Avoid browser navigation if a file misses the upload target.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());

convert.addEventListener('click', async () => {
  if (isBusy() || html === null) return;
  if (!validateViewport()) return;
  requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  cancelled = false; parsed = null; get('report').hidden = true; json.hidden = true;
  status('HTML을 렌더링하고 레이아웃을 분석합니다…', 'converting'); renderControls();
  try {
    parsed = await parseHTML(html, { viewport: viewportWidth.valueAsNumber, viewportHeight: viewportHeight.valueAsNumber, autoLayout: autoLayout.checked, styles: styles.checked,
      images: images.checked, shadows: shadows.checked, optimizeWrappers: optimize.checked, debug: debug.checked }, get('render-host'), localAssets);
    if (cancelled) { finishConversion('error', '변환을 취소했습니다.'); return; }
    console.info('HTML → Figma intermediate document', parsed);
    json.hidden = false;
    status('Figma 레이어를 생성합니다…');
    send({ type: 'CREATE_FIGMA', requestId, fileName: selectedFileName, payload: parsed });
  } catch (error) {
    console.warn('HTML analysis failed', error);
    finishConversion('error', `HTML을 변환하지 못했습니다. ${reportText(errorMessage(error))}`);
  }
});
cancel.addEventListener('click', () => { cancelled = true; if (conversionStatus === 'converting') send({ type: 'CANCEL' }); status('변환을 취소하고 있습니다…'); cancel.disabled = true; });
json.addEventListener('click', () => {
  if (!parsed) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(parsed, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'html-to-figma.json'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function showReport(report: ConversionReport | undefined, outcome: ConversionOutcome): void {
  get('report').hidden = false;
  get('report').dataset.result = outcome.status;
  get('report-file').textContent = outcome.fileName;
  get('report-result').textContent = outcome.result.frameCreated ? 'Figma Frame 생성 완료' : '결과 Frame을 생성하지 못했습니다.';
  get('report-error').hidden = outcome.status !== 'ERROR';
  get('report-error').textContent = outcome.errorMessage || '';
  get('report-stats').hidden = !report;
  get<HTMLDetailsElement>('report-stats').open = false;
  if (report) {
    for (const [id, value] of [['total-count', report.total], ['frame-count', report.frames], ['layout-count', report.autoLayout], ['text-count', report.text], ['image-count', report.image], ['grid-count', report.grid], ['absolute-count', report.absolute], ['svg-count', report.svg]] as const) get(id).textContent = String(value);
    get('duration').textContent = `Figma 노드 생성: ${(report.durationMs / 1000).toFixed(2)}초`;
  }
  get('warning-count').textContent = outcome.warningCount ? `경고 ${outcome.warningCount}건 (동일 원인은 묶어서 표시)` : outcome.status === 'ERROR' ? '' : '확인된 경고가 없습니다.';
  get('warning-types').textContent = Object.entries(outcome.warningTypes).map(([code, count]) => `${REPORT_LABELS[code as keyof typeof REPORT_LABELS]} ${count}건`).join(' · ');
  get('warning-summary').textContent = '상세 내용 보기';
  get<HTMLDetailsElement>('warning-details').open = false;
  const list = get('warnings'); list.replaceChildren();
  let shown = 0;
  const detailLabels: Record<string, string> = { reason: '원인', originalFont: '원본 글꼴', originalWeight: '원본 굵기', originalStyle: '원본 스타일', fallbackFont: '대체 글꼴', fallbackStyle: '대체 스타일', cssProperty: 'CSS 속성', cssValue: 'CSS 값', resource: '리소스', resourceType: '리소스 종류', stage: '처리 단계' };
  const more = get<HTMLButtonElement>('warning-more');
  const appendWarnings = () => {
    for (const warning of outcome.warnings.slice(shown, shown + 30)) {
      const group = document.createElement('li');
      const title = document.createElement('strong'); title.textContent = `${REPORT_LABELS[warning.code]} · ${warning.count}회`; group.append(title);
      for (const text of [warning.message, ...Object.entries(warning.detail).map(([key, value]) => `${detailLabels[key] || key}: ${value}`), warning.locations.length ? `위치: ${warning.locations.join(', ')}` : '']) {
        if (!text) continue;
        const line = document.createElement('div'); line.textContent = text; group.append(line);
      }
      list.append(group);
    }
    shown += 30; more.hidden = shown >= outcome.warnings.length;
  };
  more.onclick = appendWarnings; appendWarnings();
  get('warning-details').hidden = outcome.warningCount === 0;
  const debugList = get('debug-warnings'); debugList.replaceChildren();
  get<HTMLDetailsElement>('debug-details').open = false;
  get('debug-details').hidden = !debug.checked || !report;
  if (debug.checked && report) for (const warning of report.warnings) {
    const item = document.createElement('li'); item.style.whiteSpace = 'pre-line';
    item.textContent = `${warning.category}: ${warning.element || warning.node} — ${warning.code}: ${warning.message}`; debugList.append(item);
  }
}
window.addEventListener('message', (event: MessageEvent<{ pluginMessage?: MainMessage }>) => {
  const message = event.data?.pluginMessage;
  // Figma may relay messages without parent as event.source; correlate the active request instead.
  if (!message || typeof message !== 'object' || message.requestId !== requestId || conversionStatus !== 'converting') return;
  if (message.type === 'PROGRESS') { status(`${message.count}개의 레이어를 생성했습니다…`); return; }
  if (message.type === 'CONVERSION_COMPLETE') {
    const { report, outcome } = message.payload || {};
    if (!outcome?.result.frameCreated || outcome.status === 'ERROR' || !report) { finishConversion('error', 'HTML을 변환하지 못했습니다. 결과 정보를 확인할 수 없습니다.'); return; }
    finishConversion('success', outcome.status === 'SUCCESS_WITH_WARNINGS' ? '변환이 완료되었습니다. 일부 항목을 확인해 주세요.' : '변환이 완료되었습니다.', report, outcome);
  } else if (message.type === 'CONVERSION_ERROR') finishConversion('error', 'HTML을 변환하지 못했습니다.', undefined, message.payload?.outcome || failedOutcome(selectedFileName, message.payload?.message || '변환 중 알 수 없는 오류가 발생했습니다.'));
});
get('status').dataset.state = conversionStatus;
renderControls();

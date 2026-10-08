import { parseHTML } from './parser';
import { LIMITS, VIEWPORT_PRESETS, type ConversionOutcome, type ConversionReport, type ConversionStatus, type LocalAssets, type MainMessage, type FileMessage, type FileConversionStatus, type ImportOptions, type ParsedDocument, type UIMessage } from './types';
import { errorMessage, isViewportDimension } from './utils';
import { failedOutcome, REPORT_LABELS, reportText } from './report';
import { MAX_HTML_FILES, batchSummary } from './batch';

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
interface UploadItem {
  id: string; file: File; state: FileConversionStatus;
  report?: ConversionReport; outcome?: ConversionOutcome; frameId?: string;
  viewport?: { width?: number; height?: number };
}
let items: UploadItem[] = [];
let batchId: string | null = null;
let currentItem: UploadItem | null = null;
let parsedItemId: string | null = null;
let pendingFile: ((message: Exclude<FileMessage, { type: 'PROGRESS' }>) => void) | null = null;
let pendingBatch: { type: 'BATCH_STARTED' | 'BATCH_COMPLETE'; resolve: (message: MainMessage) => void } | null = null;
let idSequence = 0;
const newId = () => `${Date.now()}-${++idSequence}-${Math.random().toString(36).slice(2)}`;
let parsed: ParsedDocument | null = null;
let conversionStatus: ConversionStatus = 'idle';
let readingFiles = false;
let cancelled = false;
let requestId: string | null = null;
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
  const filesValid = items.every(item => [item.viewport?.width, item.viewport?.height].every(value => value === undefined || isViewportDimension(value)));
  get('file-viewport-error').hidden = filesValid;
  for (const field of document.querySelectorAll<HTMLInputElement>('.file-viewport input')) field.placeholder = field.dataset.dimension === 'width' ? viewportWidth.value : viewportHeight.value;
  convert.disabled = isBusy() || items.length === 0 || !widthValid || !heightValid || !filesValid;
  return widthValid && heightValid && filesValid;
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
  for (const field of document.querySelectorAll<HTMLInputElement>('.file-viewport input')) field.disabled = value;
  cancel.hidden = !value;
  if (!value) cancel.disabled = false;
  convert.textContent = conversionStatus === 'converting' ? '변환 중…' : 'Figma로 변환';
}
function renderItems(): void {
  get('file-list-section').hidden = items.length === 0;
  get('file-list-title').textContent = `선택한 파일 (${items.length}/${MAX_HTML_FILES})`;
  const list = get('file-list'); list.replaceChildren();
  const labels: Record<FileConversionStatus, string> = { WAITING: '대기', CONVERTING: '변환 중', SUCCESS: '변환 완료', SUCCESS_WITH_WARNINGS: '경고와 함께 변환 완료', ERROR: '변환 실패' };
  for (const item of items) {
    const row = document.createElement('li'); row.dataset.itemId = item.id; row.dataset.state = item.state;
    const name = document.createElement('strong'); name.textContent = item.file.name; row.append(name);
    const state = document.createElement('span'); state.className = 'muted';
    state.textContent = `${labels[item.state]}${item.outcome && item.state !== 'ERROR' ? ` · 경고 ${item.outcome.warningCount}건` : ''}`; row.append(state);
    if (items.length > 1) {
      const dimensions = document.createElement('details'); dimensions.className = 'file-viewport';
      const summary = document.createElement('summary'); summary.textContent = item.viewport && Object.values(item.viewport).some(value => value !== undefined) ? `Viewport: ${item.viewport.width ?? viewportWidth.value} × ${item.viewport.height ?? viewportHeight.value}` : 'Viewport 지정 (기본: 공통 설정)'; dimensions.append(summary);
      const fields = document.createElement('div'); fields.className = 'dimensions';
      for (const [dimension, label] of [['width', '너비'], ['height', '높이']] as const) {
        const wrapper = document.createElement('label'); wrapper.className = 'dimension'; wrapper.textContent = `${label} (px)`;
        const field = document.createElement('input'); field.type = 'number'; field.min = '1'; field.max = '10000'; field.step = '1'; field.dataset.dimension = dimension;
        field.setAttribute('aria-label', `${item.file.name} ${label}`); field.setAttribute('aria-describedby', 'file-viewport-error');
        field.value = item.viewport?.[dimension] === undefined ? '' : String(item.viewport[dimension]); field.placeholder = dimension === 'width' ? viewportWidth.value : viewportHeight.value; field.disabled = isBusy();
        field.oninput = () => {
          item.viewport ||= {}; item.viewport[dimension] = field.value === '' && !field.validity.badInput ? undefined : field.valueAsNumber;
          field.setAttribute('aria-invalid', String(item.viewport[dimension] !== undefined && !isViewportDimension(item.viewport[dimension]!)));
          summary.textContent = `Viewport: ${item.viewport.width ?? viewportWidth.value} × ${item.viewport.height ?? viewportHeight.value}`; validateViewport();
        };
        wrapper.append(field); fields.append(wrapper);
      }
      dimensions.append(fields); row.append(dimensions);
    }
    if (!isBusy() && items.every(entry => entry.state === 'WAITING')) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary remove-file'; remove.textContent = '제거'; remove.setAttribute('aria-label', `${item.file.name} 제거`);
      remove.onclick = () => { if (isBusy()) return; items = items.filter(entry => entry.id !== item.id); updateSelectionLabel(); renderItems(); renderControls(); };
      row.append(remove);
    }
    if (item.outcome) {
      const detail = document.createElement('button'); detail.type = 'button'; detail.className = 'secondary file-detail'; detail.textContent = item.state === 'ERROR' ? '오류 상세 보기' : '상세 내용 보기'; detail.disabled = isBusy();
      detail.onclick = () => { displayReport(item); json.hidden = !parsed || parsedItemId !== item.id; };
      row.append(detail);
    }
    list.append(row);
  }
}
function updateSelectionLabel(): void {
  get('filename').textContent = items.length === 1 ? items[0]!.file.name : items.length ? `HTML 파일 ${items.length}개 선택` : 'HTML 파일 업로드';
  get('fileinfo').textContent = items.length === 1 ? `${(items[0]!.file.size / 1024).toFixed(1)} KB · 다른 파일을 선택하려면 클릭` : '드래그하거나 클릭하여 선택 · .html / .htm · 최대 10개 · 파일당 5MB';
}
function displayReport(item: UploadItem): void {
  if (!item.outcome) return;
  try { showReport(item.report, item.outcome); }
  catch (error) {
    get('report').hidden = true;
    console.warn('Conversion report display failed', error);
    status(`${get('status').textContent} 보고서를 표시하지 못했습니다. Figma에서 결과를 확인해 주세요.`);
  }
}
function clearReport(): void {
  get('report').hidden = true;
  get('warnings').replaceChildren(); get('debug-warnings').replaceChildren();
  get<HTMLButtonElement>('warning-more').onclick = null;
}
function finishConversion(state: 'success' | 'error', message: string): void {
  requestId = null; batchId = null; cancelled = false;
  input.value = ''; dropzone.classList.remove('drag');
  status(message, state);
  if (currentItem) displayReport(currentItem);
  renderItems(); renderControls();
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
async function selectFiles(files: File[]): Promise<void> {
  if (isBusy() || !files.length) return;
  input.value = '';
  // Validate a replacement atomically; a rejected upload preserves the current valid list.
  if (files.length > MAX_HTML_FILES) { status('HTML 파일은 최대 10개까지 선택할 수 있습니다.', 'error'); return; }
  if (files.some(file => !/\.html?$/i.test(file.name))) { status('HTML 파일만 업로드할 수 있습니다.', 'error'); return; }
  if (files.some(file => file.size > LIMITS.fileBytes)) { status('파일이 5MB 제한을 초과했습니다.', 'error'); return; }
  cancelled = false; readingFiles = true; status('HTML 파일을 읽고 있습니다.', 'idle'); renderControls(); renderItems();
  try {
    // Keep File objects, not ten HTML strings or ten rendered documents, in the selection.
    for (const file of files) {
      const content = await readFile(file);
      if (cancelled) return;
      if (!content.trim()) throw new Error(`${file.name}: HTML 파일이 비어 있습니다.`);
    }
    items = files.map(file => ({ id: newId(), file, state: 'WAITING' }));
    requestId = batchId = null; currentItem = null; parsed = null; parsedItemId = null;
    json.hidden = true; clearReport(); get('batch-summary').hidden = true;
    updateSelectionLabel(); status('준비되었습니다. Viewport를 설정하고 변환하세요.', 'idle');
  } catch (error) { status(errorMessage(error), 'error'); }
  finally {
    if (cancelled) status('파일 선택을 취소했습니다.', 'idle');
    cancelled = false; readingFiles = false; renderItems(); renderControls(); input.value = '';
  }
}
input.addEventListener('change', () => { void selectFiles(Array.from(input.files || [])); });
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
dropzone.addEventListener('click', event => { if (isBusy()) event.preventDefault(); else input.value = ''; });
for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, event => { event.preventDefault(); if (!isBusy()) dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('drag'); void selectFiles(Array.from(event.dataTransfer?.files || [])); });
// Avoid browser navigation if a file misses the upload target.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());

function waitForBatch(type: 'BATCH_STARTED' | 'BATCH_COMPLETE', message: UIMessage): Promise<MainMessage> {
  return new Promise(resolve => { pendingBatch = { type, resolve }; send(message); });
}
function waitForFile(message: UIMessage): Promise<Exclude<FileMessage, { type: 'PROGRESS' }>> {
  return new Promise(resolve => { pendingFile = resolve; send(message); });
}
function progress(message: string): void {
  const completed = items.filter(item => item.outcome).length;
  const index = currentItem ? items.indexOf(currentItem) + 1 : completed;
  status(items.length > 1 ? `${index} / ${items.length}개 파일 처리 중 · 완료 ${completed}개 — ${message}` : message);
}
convert.addEventListener('click', async () => {
  if (isBusy() || !items.length || !validateViewport()) return;
  const options: ImportOptions = { viewport: viewportWidth.valueAsNumber, viewportHeight: viewportHeight.valueAsNumber, autoLayout: autoLayout.checked, styles: styles.checked,
    images: images.checked, shadows: shadows.checked, optimizeWrappers: optimize.checked, debug: debug.checked };
  const assets = localAssets; // An explicit user-selected asset map; parser caches remain per file.
  batchId = items.length > 1 ? newId() : null;
  cancelled = false; parsed = null; parsedItemId = null; currentItem = null;
  for (const item of items) { item.state = 'WAITING'; delete item.outcome; delete item.report; delete item.frameId; }
  clearReport(); get('batch-summary').hidden = true; json.hidden = true;
  status('HTML을 렌더링하고 레이아웃을 분석합니다…', 'converting'); renderControls(); renderItems();
  let started = false;
  let batchError: string | null = null;
  try {
    if (batchId) {
      const reply = await waitForBatch('BATCH_STARTED', { type: 'BATCH_START', batchId, items: items.map(item => ({ itemId: item.id, fileName: item.file.name })) });
      if (reply.type === 'BATCH_ERROR') throw new Error(reply.message);
      started = true;
    }
    for (const item of items) {
      if (cancelled) break;
      currentItem = item; item.state = 'CONVERTING'; requestId = newId();
      parsed = null; parsedItemId = null; json.hidden = true;
      progress('HTML을 렌더링하고 레이아웃을 분석합니다…'); renderItems();
      let parseError: string | null = null;
      try {
        const source = await readFile(item.file);
        if (!source.trim()) throw new Error('HTML 파일이 비어 있습니다.');
        const fileOptions = { ...options, viewport: item.viewport?.width ?? options.viewport, viewportHeight: item.viewport?.height ?? options.viewportHeight };
        if (!cancelled) parsed = await parseHTML(source, fileOptions, get('render-host'), assets);
        if (cancelled) throw new Error('변환을 취소했습니다.');
        parsedItemId = item.id;
        if (options.debug) console.info('HTML → Figma intermediate document', { batchId, itemId: item.id, fileName: item.file.name, document: parsed });
      } catch (error) { console.warn('HTML analysis failed', error); parseError = errorMessage(error); }
      let reply: Exclude<FileMessage, { type: 'PROGRESS' }> | undefined;
      if (parseError) {
        if (batchId) reply = await waitForFile({ type: 'FILE_ANALYSIS_ERROR', requestId, batchId, itemId: item.id, message: parseError });
        else item.outcome = failedOutcome(item.file.name, parseError);
      } else if (parsed) {
        progress('Figma 레이어를 생성합니다…');
        reply = await waitForFile({ type: 'CREATE_FIGMA', requestId, fileName: item.file.name, payload: parsed, ...(batchId ? { batchId, itemId: item.id } : {}) });
      }
      if (reply?.type === 'CONVERSION_COMPLETE') {
        const { report, outcome, frameId } = reply.payload || {};
        if (!outcome?.result?.frameCreated || outcome.status === 'ERROR' || !report) item.outcome = failedOutcome(item.file.name, '결과 정보를 확인할 수 없습니다.');
        else { item.report = report; item.outcome = outcome; item.frameId = frameId; }
      } else if (reply?.type === 'CONVERSION_ERROR') item.outcome = reply.payload?.outcome || failedOutcome(item.file.name, reply.payload?.message || '변환 중 알 수 없는 오류가 발생했습니다.');
      item.outcome ||= failedOutcome(item.file.name, '결과 정보를 확인할 수 없습니다.');
      item.state = item.outcome.status;
      requestId = null; renderItems();
      // Keep only the last intermediate document for the existing JSON export.
      // Each parseHTML call disposes its iframe; no DOM or asset cache is retained by items.
    }
  } catch (error) {
    batchError = reportText(errorMessage(error));
    if (currentItem?.state === 'CONVERTING') {
      currentItem.outcome = failedOutcome(currentItem.file.name, batchError); currentItem.state = 'ERROR';
    }
  }
  finally {
    try {
      if (batchId && started) {
        const reply = await waitForBatch('BATCH_COMPLETE', { type: 'BATCH_FINISH', batchId, cancelled: cancelled || !!batchError });
        if (reply.type === 'BATCH_ERROR') batchError = reply.message;
      }
    } catch (error) { batchError = reportText(errorMessage(error)); }
    pendingFile = null; pendingBatch = null;
    const summary = batchSummary(items.length, items.flatMap(item => item.outcome ? [item.outcome] : []), cancelled);
    if (items.length > 1) {
      const summaryElement = get('batch-summary'); summaryElement.hidden = false;
      summaryElement.textContent = `총 ${summary.total}개 파일 · 정상 완료 ${summary.success}개 · 경고 포함 완료 ${summary.warnings}개 · 실패 ${summary.errors}개${summary.waiting ? ` · 미처리 ${summary.waiting}개` : ''}`;
      finishConversion(batchError || cancelled || !(summary.success + summary.warnings) ? 'error' : 'success', batchError ? `전체 변환을 마치지 못했습니다. ${batchError}` : cancelled ? '변환을 취소했습니다.' : '파일 처리가 완료되었습니다.');
    } else {
      const outcome = items[0]?.outcome;
      finishConversion(outcome?.status === 'ERROR' || !outcome ? 'error' : 'success', cancelled ? '변환을 취소했습니다.' : outcome?.status === 'SUCCESS' ? '변환이 완료되었습니다.' : outcome?.status === 'SUCCESS_WITH_WARNINGS' ? '변환이 완료되었습니다. 일부 항목을 확인해 주세요.' : 'HTML을 변환하지 못했습니다.');
    }
    json.hidden = !parsed;
  }
});
cancel.addEventListener('click', () => {
  cancelled = true;
  if (conversionStatus === 'converting') send({ type: 'CANCEL', ...(batchId ? { batchId } : requestId ? { requestId } : {}) });
  status('변환을 취소하고 있습니다…'); cancel.disabled = true;
});
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
  if (!message || typeof message !== 'object' || conversionStatus !== 'converting') return;
  if (message.type === 'BATCH_STARTED' || message.type === 'BATCH_COMPLETE' || message.type === 'BATCH_ERROR') {
    if (message.batchId !== batchId || !pendingBatch || (message.type !== pendingBatch.type && message.type !== 'BATCH_ERROR')) return;
    const resolve = pendingBatch.resolve; pendingBatch = null; resolve(message); return;
  }
  // Check all three identities: duplicate names and late messages cannot advance the queue.
  if (message.requestId !== requestId || (batchId ? message.batchId !== batchId || message.itemId !== currentItem?.id : message.batchId !== undefined || message.itemId !== undefined)) return;
  if (message.type === 'PROGRESS') { progress(`${message.count}개의 레이어를 생성했습니다…`); return; }
  if (message.type !== 'CONVERSION_COMPLETE' && message.type !== 'CONVERSION_ERROR') return;
  if (pendingFile) { const resolve = pendingFile; pendingFile = null; resolve(message); }
});
get('status').dataset.state = conversionStatus;
renderControls();

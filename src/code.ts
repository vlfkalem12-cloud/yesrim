import { convertDocument, validateDocument } from './converter';
import type { BatchItem, ConversionOutcome, FileMessage, MainMessage, UIMessage } from './types';
import { errorMessage } from './utils';
import { conversionOutcome, failedOutcome } from './report';
import { BATCH_FRAME_GAP, MAX_HTML_FILES, batchSummary } from './batch';

figma.showUI(__html__, { width: 440, height: 760, themeColors: true });
let busy = false;
let cancelled = false;
let activeRequestId: string | null = null;
interface BatchSession {
  id: string; items: BatchItem[]; next: number; outcomes: ConversionOutcome[]; frames: FrameNode[];
  center: { x: number; y: number }; x?: number; y?: number;
}
let batch: BatchSession | null = null;
const send = (message: MainMessage) => figma.ui.postMessage(message);
figma.ui.onmessage = async (message: UIMessage) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'CANCEL') {
    if (message.batchId ? message.batchId === batch?.id : (!batch && (!message.requestId || message.requestId === activeRequestId))) cancelled = true;
    return;
  }
  if (message.type === 'BATCH_START') {
    if (typeof message.batchId !== 'string') return;
    const valid = Array.isArray(message.items) && message.items.length >= 2 && message.items.length <= MAX_HTML_FILES
      && message.items.every(item => item && typeof item.itemId === 'string' && item.itemId && typeof item.fileName === 'string')
      && new Set(message.items.map(item => item.itemId)).size === message.items.length;
    if (busy || batch || !valid) {
      send({ type: 'BATCH_ERROR', batchId: message.batchId, message: busy || batch ? '이미 변환이 진행 중입니다.' : 'HTML 파일은 2~10개를 선택하세요.' }); return;
    }
    try {
      batch = { id: message.batchId, items: message.items.map(item => ({ ...item })), next: 0, outcomes: [], frames: [], center: { ...figma.viewport.center } };
      cancelled = false;
      send({ type: 'BATCH_STARTED', batchId: batch.id });
    } catch (error) {
      batch = null;
      send({ type: 'BATCH_ERROR', batchId: message.batchId, message: errorMessage(error) });
    }
    return;
  }
  if (message.type === 'BATCH_FINISH') {
    if (message.batchId !== batch?.id) return;
    const session = batch;
    if (busy || (!message.cancelled && session.next !== session.items.length)) {
      send({ type: 'BATCH_ERROR', batchId: session.id, message: '파일 처리가 아직 완료되지 않았습니다.' }); return;
    }
    batch = null; cancelled = false;
    // Presentation errors cannot turn completed file conversions into failures.
    const frames = session.frames.filter(frame => !frame.removed);
    try { if (frames.length) { figma.currentPage.selection = frames; figma.viewport.scrollAndZoomIntoView(frames); } }
    catch (error) { console.warn('Batch viewport update failed', error); }
    send({ type: 'BATCH_COMPLETE', batchId: session.id, summary: batchSummary(session.items.length, session.outcomes, message.cancelled) }); return;
  }
  if (!['CREATE_FIGMA', 'FILE_ANALYSIS_ERROR'].includes(message.type) || !('requestId' in message) || typeof message.requestId !== 'string') return;
  if (message.type !== 'CREATE_FIGMA' && message.type !== 'FILE_ANALYSIS_ERROR') return;
  const context = message.batchId !== undefined || message.itemId !== undefined ? { batchId: message.batchId, itemId: message.itemId } : {};
  const session = batch;
  const item = session?.items[session.next];
  const matchesBatch = !!session && !!item && message.batchId === session.id && message.itemId === item.itemId;
  const fileName = matchesBatch ? item!.fileName : message.type === 'CREATE_FIGMA' && typeof message.fileName === 'string' ? message.fileName : '';
  const reject = (text: string) => send({ type: 'CONVERSION_ERROR', requestId: message.requestId, ...context, payload: { success: false, message: text, outcome: failedOutcome(fileName, text) } });
  if (busy) { reject('이미 변환이 진행 중입니다.'); return; }
  if (session ? !matchesBatch : message.batchId !== undefined || message.itemId !== undefined || message.type === 'FILE_ANALYSIS_ERROR') { reject('현재 파일 요청과 일치하지 않습니다.'); return; }
  busy = true; if (!session) cancelled = false;
  activeRequestId = message.requestId;
  const requestId = message.requestId;
  let result: Exclude<FileMessage, { type: 'PROGRESS' }>;
  let created: FrameNode | undefined;
  try {
    if (cancelled) throw new Error('변환을 취소했습니다.');
    if (message.type === 'FILE_ANALYSIS_ERROR') throw new Error(message.message);
    validateDocument(message.payload);
    const { frame, report } = await convertDocument(message.payload, count => send({ type: 'PROGRESS', requestId, ...context, count }), () => cancelled);
    created = frame;
    if (frame.removed) throw new Error('결과 Frame이 생성되지 않았습니다.');
    if (session) {
      // Only root Canvas coordinates change. No resizing, reparenting or internal edits.
      const x = session.x ?? session.center.x - frame.width / 2;
      const y = session.y ?? session.center.y - frame.height / 2;
      frame.x = x; frame.y = y;
    }
    result = { type: 'CONVERSION_COMPLETE', requestId, ...context, payload: { success: true, report, outcome: conversionOutcome(report, fileName, message.payload.options), frameId: frame.id } };
    if (session) { session.frames.push(frame); session.x = frame.x + frame.width + BATCH_FRAME_GAP; session.y = frame.y; }
  } catch (error) {
    if (created && !created.removed) {
      try { created.remove(); } catch (cleanupError) { console.warn('Failed result cleanup failed', cleanupError); }
    }
    const text = errorMessage(error);
    console.warn('HTML → Figma conversion failed', error);
    result = { type: 'CONVERSION_ERROR', requestId, ...context, payload: { success: false, message: text, outcome: failedOutcome(fileName, text) } };
  } finally { busy = false; activeRequestId = null; }
  if (session) { session.outcomes.push(result.payload.outcome); session.next++; }
  send(result);
  if (result.type === 'CONVERSION_COMPLETE') {
    try { figma.notify(`${result.payload.report.total}개의 편집 가능한 레이어를 생성했습니다.`); }
    catch (error) { console.warn('Conversion notification failed', error); }
  }
};

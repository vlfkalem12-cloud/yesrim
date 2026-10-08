import { convertDocument, validateDocument } from './converter';
import type { MainMessage, UIMessage } from './types';
import { errorMessage } from './utils';
import { conversionOutcome, failedOutcome } from './report';

figma.showUI(__html__, { width: 440, height: 760, themeColors: true });
let busy = false;
let cancelled = false;
const send = (message: MainMessage) => figma.ui.postMessage(message);
figma.ui.onmessage = async (message: UIMessage) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'CANCEL') { cancelled = true; return; }
  if (message.type !== 'CREATE_FIGMA' || typeof message.requestId !== 'string') return;
  if (busy) {
    const text = '이미 변환이 진행 중입니다.';
    send({ type: 'CONVERSION_ERROR', requestId: message.requestId, payload: { success: false, message: text, outcome: failedOutcome(message.fileName || '', text) } });
    return;
  }
  busy = true; cancelled = false;
  const requestId = message.requestId;
  const fileName = typeof message.fileName === 'string' ? message.fileName : '';
  let result: Exclude<MainMessage, { type: 'PROGRESS' }>;
  try {
    validateDocument(message.payload);
    const { frame, report } = await convertDocument(message.payload, count => send({ type: 'PROGRESS', requestId, count }), () => cancelled);
    if (frame.removed) throw new Error('결과 Frame이 생성되지 않았습니다.');
    result = { type: 'CONVERSION_COMPLETE', requestId, payload: { success: true, report, outcome: conversionOutcome(report, fileName, message.payload.options) } };
  } catch (error) {
    const text = errorMessage(error);
    console.warn('HTML → Figma conversion failed', error);
    result = { type: 'CONVERSION_ERROR', requestId, payload: { success: false, message: text, outcome: failedOutcome(fileName, text) } };
  }
  finally { busy = false; }
  send(result);
  if (result.type === 'CONVERSION_COMPLETE') {
    try { figma.notify(`${result.payload.report.total}개의 편집 가능한 레이어를 생성했습니다.`); }
    catch (error) { console.warn('Conversion notification failed', error); }
  }
};

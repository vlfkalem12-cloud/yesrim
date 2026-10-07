import { convertDocument, validateDocument } from './converter';
import type { MainMessage, UIMessage } from './types';
import { errorMessage } from './utils';

figma.showUI(__html__, { width: 440, height: 760, themeColors: true });
let busy = false;
let cancelled = false;
const send = (message: MainMessage) => figma.ui.postMessage(message);
figma.ui.onmessage = async (message: UIMessage) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'CANCEL') { cancelled = true; return; }
  if (message.type !== 'CREATE_FIGMA' || typeof message.requestId !== 'string') return;
  if (busy) {
    send({ type: 'CONVERSION_ERROR', requestId: message.requestId, payload: { success: false, message: '이미 변환이 진행 중입니다.' } });
    return;
  }
  busy = true; cancelled = false;
  const requestId = message.requestId;
  let result: Exclude<MainMessage, { type: 'PROGRESS' }>;
  try {
    validateDocument(message.payload);
    const { report } = await convertDocument(message.payload, count => send({ type: 'PROGRESS', requestId, count }), () => cancelled);
    result = { type: 'CONVERSION_COMPLETE', requestId, payload: { success: true, report } };
  } catch (error) { result = { type: 'CONVERSION_ERROR', requestId, payload: { success: false, message: errorMessage(error) } }; }
  finally { busy = false; }
  send(result);
  if (result.type === 'CONVERSION_COMPLETE') {
    try { figma.notify(`${result.payload.report.total}개의 편집 가능한 레이어를 생성했습니다.`); }
    catch (error) { console.warn('Conversion notification failed', error); }
  }
};

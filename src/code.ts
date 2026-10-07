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
  if (message.type !== 'CREATE_FIGMA' || typeof message.requestId !== 'string' || busy) return;
  busy = true; cancelled = false;
  const requestId = message.requestId;
  try {
    validateDocument(message.payload);
    const { report } = await convertDocument(message.payload, count => send({ type: 'PROGRESS', requestId, count }), () => cancelled);
    send({ type: 'COMPLETE', requestId, report });
    figma.notify(`${report.total}개의 편집 가능한 레이어를 생성했습니다.`);
  } catch (error) { send({ type: 'ERROR', requestId, message: errorMessage(error) }); }
  finally { busy = false; }
};

import type { BatchSummary, ConversionOutcome } from './types';

export const MAX_HTML_FILES = 10;
export const BATCH_FRAME_GAP = 120;
export function batchSummary(total: number, outcomes: ConversionOutcome[], cancelled = false): BatchSummary {
  return {
    total, success: outcomes.filter(item => item.status === 'SUCCESS').length,
    warnings: outcomes.filter(item => item.status === 'SUCCESS_WITH_WARNINGS').length,
    errors: outcomes.filter(item => item.status === 'ERROR').length,
    waiting: total - outcomes.length, cancelled
  };
}

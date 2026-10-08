import { LIMITS } from './types';
import { MAX_HTML_FILES } from './batch';

export const UPLOAD_ERRORS = {
  count: 'HTML 파일은 최대 10개까지 선택할 수 있습니다.', duplicate: '이미 추가된 파일입니다.',
  extension: 'HTML 파일만 업로드할 수 있습니다.', size: '파일당 최대 5MB까지 업로드할 수 있습니다.',
  empty: '내용이 없는 HTML 파일은 업로드할 수 없습니다.', read: '파일을 읽지 못했습니다. 다시 선택해 주세요.'
} as const;
export function readHTMLFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(UPLOAD_ERRORS.read));
    reader.onerror = reader.onabort = () => reject(new Error(UPLOAD_ERRORS.read));
    reader.readAsText(file);
  });
}
export async function validateHTMLSelection(files: File[], cancelled: () => boolean): Promise<void> {
  // Count takes precedence over duplicate/type errors. Never silently filter the selection.
  if (files.length > MAX_HTML_FILES) throw new Error(UPLOAD_ERRORS.count);
  if (files.some(file => !/\.html?$/i.test(file.name))) throw new Error(UPLOAD_ERRORS.extension);
  if (files.some(file => file.size > LIMITS.fileBytes)) throw new Error(UPLOAD_ERRORS.size);
  const key = (file: File) => JSON.stringify([file.webkitRelativePath || file.name, file.size]);
  const counts = new Map<string, number>();
  for (const file of files) counts.set(key(file), (counts.get(key(file)) || 0) + 1);
  const contentKeys = new Map<string, Set<string>>();
  for (const file of files) {
    const content = await readHTMLFile(file);
    if (cancelled()) return;
    if (!content.trim()) throw new Error(UPLOAD_ERRORS.empty);
    if (counts.get(key(file))! < 2) continue;
    // Reuse the validation read, hash only candidates with matching name/path and byte size.
    // A modified timestamp does not establish content equality. Unavailable SubtleCrypto
    // falls back to exact decoded-content comparison within this temporary validation scope.
    const fingerprint = globalThis.crypto?.subtle
      ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))).map(byte => byte.toString(16).padStart(2, '0')).join('')
      : content;
    const seen = contentKeys.get(key(file)) || new Set<string>();
    if (seen.has(fingerprint)) throw new Error(UPLOAD_ERRORS.duplicate);
    seen.add(fingerprint); contentKeys.set(key(file), seen);
  }
}

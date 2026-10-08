import { LIMITS, type ImportOptions, type LocalAssets, type ParsedImage, type ParsedNode } from './types';
import { errorMessage, withTimeout } from './utils';

export const allowedAsset = (url: string) => /^https:\/\//i.test(url) || /^data:image\//i.test(url);
export function resolveLocalAsset(url: string, files: LocalAssets): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//')) return undefined;
  let path: string;
  try { path = decodeURIComponent(url.split(/[?#]/)[0]!).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, ''); } catch { return undefined; }
  const found = files[path] || files[path.split('/').pop()!];
  return found && allowedAsset(found) ? found : undefined;
}
export async function collectImages(root: ParsedNode, doc: Document, options: ImportOptions, assets: Record<string, number[]>, warn: (code: string, node: string, message: string) => void): Promise<void> {
  if (options.images === false) return;
  const stack = [root]; const requests: { image: ParsedImage; name: string }[] = [];
  while (stack.length) {
    const node = stack.pop()!; stack.push(...node.children);
    if (node.image) requests.push({ image: node.image, name: node.name });
    if (options.styles) {
      const backgrounds = node.style.backgroundLayers ? node.style.backgroundLayers.flatMap(layer => layer.type === 'IMAGE' ? [layer.image] : []) : node.style.backgroundImage ? [node.style.backgroundImage] : [];
      for (const image of backgrounds) requests.push({ image, name: node.name });
    }
  }
  const cache = new Map<string, Promise<string>>();
  const existing = new Map<string, HTMLImageElement>();
  for (const img of doc.images) if (img.getAttribute('src')) existing.set(img.getAttribute('src')!, img);
  let totalBytes = 0, keyIndex = 0, nextRequest = 0;
  async function load(src: string): Promise<string> {
    if (!allowedAsset(src)) throw new Error('HTTPS 또는 data:image URL이 필요합니다. 상대 경로 이미지는 파일을 추가하세요.');
    const img = existing.get(src) || doc.createElement('img');
    if (!existing.has(src)) { if (/^https:/i.test(src)) img.crossOrigin = 'anonymous'; img.src = src; }
    try { await withTimeout(img.decode(), LIMITS.loadMs, '이미지 로딩 시간 초과'); }
    catch (error) { if (!existing.has(src)) img.src = ''; throw error; }
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 16000000) throw new Error('이미지 치수가 없거나 16MP 제한을 초과했습니다.');
    const canvas = doc.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d'); if (!context) throw new Error('이미지를 읽을 수 없습니다.');
    context.drawImage(img, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('이미지 변환 실패')), 'image/png'));
    if (blob.size > LIMITS.imageBytes || totalBytes + blob.size > LIMITS.assetBytes) throw new Error('이미지 용량 제한을 초과했습니다.');
    totalBytes += blob.size;
    const key = `image-${++keyIndex}`; assets[key] = [...new Uint8Array(await blob.arrayBuffer())]; return key;
  }
  async function worker(): Promise<void> {
    while (nextRequest < requests.length) {
      const request = requests[nextRequest++]!;
      if (!cache.has(request.image.src)) cache.set(request.image.src, load(request.image.src));
      try { request.image.key = await cache.get(request.image.src)!; }
      catch (error) { warn('IMAGE_LOAD', request.name, `Image Load Failed: ${request.image.src.slice(0, 180)} — ${errorMessage(error)}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, () => worker()));
}

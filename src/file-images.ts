import { LIMITS, type LocalAssetBundle } from './types';
import { normalizeLocalAssetPath } from './assets';
export interface FileImage { id: string; name: string; size: number; dataURL: string; path: string }
export function buildImageBundle(images: readonly FileImage[]): LocalAssetBundle {
  const paths: Record<string, string> = Object.create(null), basenames: Record<string, string> = Object.create(null);
  const byPath = new Map<string, FileImage[]>(), byName = new Map<string, FileImage[]>();
  for (const image of images) {
    const path = image.path.trim() ? normalizeLocalAssetPath(image.path) : undefined;
    if (path) byPath.set(path, [...(byPath.get(path) || []), image]);
    byName.set(image.name, [...(byName.get(image.name) || []), image]);
  }
  for (const [path, candidates] of byPath) paths[path] = candidates.length === 1 ? candidates[0]!.dataURL : '';
  for (const [name, candidates] of byName) if (candidates.length === 1) basenames[name] = candidates[0]!.dataURL;
  return { paths, basenames };
}
export function imageMappingNotice(images: readonly FileImage[]): string {
  if (images.some(image => image.path.trim() && !normalizeLocalAssetPath(image.path))) return '상대 경로를 확인해 주세요. URL이나 잘못된 경로는 연결하지 않습니다.';
  const paths = images.filter(image => image.path.trim()).map(image => normalizeLocalAssetPath(image.path));
  if (new Set(paths).size !== paths.length) return '동일한 경로가 중복되어 연결할 수 없습니다. 이미지별 경로를 다르게 지정해 주세요.';
  if (new Set(images.map(image => image.name)).size !== images.length) return '같은 파일명의 이미지가 있습니다. 정확한 상대 경로가 일치할 때만 연결합니다.';
  return '경로가 일치하는 이미지를 우선 연결합니다. 경로가 없으면 유일한 파일명을 사용합니다.';
}
export async function readFileImages(files: File[], id: () => string): Promise<FileImage[]> {
  if (files.length > 100 || files.some(file => file.size > LIMITS.imageBytes) || files.reduce((sum, file) => sum + file.size, 0) > LIMITS.assetBytes)
    throw new Error('이미지는 파일당 4MB, 총 16MB, 최대 100개까지 추가할 수 있습니다.');
  return Promise.all(files.map(async file => {
    const dataURL = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('이미지 파일을 읽지 못했습니다.'));
      reader.onerror = () => reject(new Error('이미지 파일을 읽지 못했습니다.')); reader.readAsDataURL(file);
    });
    if (!/^data:image\//i.test(dataURL)) throw new Error(`${file.name}은 지원하는 이미지 파일이 아닙니다.`);
    return { id: id(), name: file.name, size: file.size, dataURL, path: file.webkitRelativePath || '' };
  }));
}

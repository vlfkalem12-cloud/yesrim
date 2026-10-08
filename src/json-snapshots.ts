import type { ParsedDocument } from './types';

export interface JSONSnapshot { blob: Blob; encoding: 'gzip' | 'json'; serializedBytes: number }
// Stream the existing two-space JSON representation. Image arrays are emitted in
// bounded pieces rather than constructing one enormous indented JavaScript string.
function* jsonChunks(doc: ParsedDocument): Generator<string> {
  yield '{\n';
  const entries = Object.entries(doc).filter(([, value]) => value !== undefined);
  for (const [index, [key, value]] of entries.entries()) {
    if (index) yield ',\n';
    yield `  ${JSON.stringify(key)}: `;
    if (key !== 'assets') { yield JSON.stringify(value, null, 2).replace(/\n/g, '\n  '); continue; }
    const images = Object.entries(doc.assets);
    if (!images.length) { yield '{}'; continue; }
    yield '{\n';
    for (const [imageIndex, [name, bytes]] of images.entries()) {
      if (imageIndex) yield ',\n';
      yield `    ${JSON.stringify(name)}: `;
      if (!bytes.length) { yield '[]'; continue; }
      yield '[\n';
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        if (offset) yield ',\n';
        yield bytes.slice(offset, offset + 4096).map(byte => `      ${JSON.stringify(byte)}`).join(',\n');
      }
      yield '\n    ]';
    }
    yield '\n  }';
  }
  yield '\n}';
}
export async function createJSONSnapshot(doc: ParsedDocument, compress = typeof CompressionStream !== 'undefined'): Promise<JSONSnapshot> {
  let serializedBytes = 0;
  const chunks = jsonChunks(doc), encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
    const chunk = chunks.next();
    if (chunk.done) { controller.close(); return; }
    const bytes = encoder.encode(chunk.value); serializedBytes += bytes.byteLength; controller.enqueue(bytes);
  } });
  const stream = compress ? source.pipeThrough(new CompressionStream('gzip')) : source;
  const blob = await new Response(stream).blob();
  return { blob, serializedBytes, encoding: compress ? 'gzip' : 'json' };
}
export async function snapshotJSONBlob(snapshot: JSONSnapshot): Promise<Blob> {
  const decoded = snapshot.encoding === 'gzip' ? await new Response(snapshot.blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob() : snapshot.blob;
  return new Blob([decoded], { type: 'application/json' });
}

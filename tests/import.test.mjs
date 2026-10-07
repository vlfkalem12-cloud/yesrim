import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createFigmaMock, flatten } from './figma-mock.mjs';

let browser, server, base, converter, parserBundle;
const sample = await readFile('examples/mvp.html', 'utf8');
before(async () => {
  await mkdir('test-results', { recursive: true });
  parserBundle = (await build({ entryPoints: ['src/parser.ts'], bundle: true, write: false, format: 'iife', globalName: 'Parser', target: 'es2020' })).outputFiles[0].text;
  await build({ entryPoints: ['src/converter.ts'], bundle: true, outfile: 'test-results/converter.mjs', format: 'esm', platform: 'node' });
  converter = await import('../test-results/converter.mjs');
  const ui = await readFile('dist/ui.html', 'utf8');
  server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url === '/ui' ? ui : '<!doctype html><html><body><div id="host"></div></body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const systemChromium = await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || systemChromium, headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
async function parse(html, overrides = {}) {
  const page = await browser.newPage();
  try {
    await page.goto(base); await page.addScriptTag({ content: parserBundle });
    // Deep IR trees exceed Chromium's inspector object-return depth. Transfer the JSON artifact.
    const serialized = await page.evaluate(async ({ html, options }) => JSON.stringify(await Parser.parseHTML(html, options, document.getElementById('host'))), { html, options: { viewport: 1440, viewportHeight: 900, autoLayout: true, styles: true, ...overrides } });
    assert.equal(await page.evaluate(() => window.hacked), undefined, 'uploaded scripts never execute');
    return JSON.parse(serialized);
  } finally { await page.close(); }
}
async function convert(doc, options) {
  const mock = createFigmaMock(options); globalThis.figma = mock.figma;
  return { ...await converter.convertDocument(doc), ...mock };
}
const find = (root, name) => flatten(root).find(node => node.name === name);
const parsedNodes = root => [root, ...root.children.flatMap(parsedNodes)];

test('MVP fixture: computed CSS → JSON → editable Figma frames and text', async () => {
  const doc = await parse(sample);
  assert.equal(doc.root.name, 'Imported HTML');
  assert.equal(doc.root.layout.direction, 'VERTICAL');
  assert.equal(doc.root.layout.gap, 40);
  assert.deepEqual(doc.root.children.map(n => n.name), ['header', 'hero', 'card-list']);
  const { frame, report, figma, fontLoads } = await convert(doc);
  assert.equal(frame.width, 1440);
  assert.equal(frame.layoutMode, 'VERTICAL');
  assert.equal(frame.paddingTop, 40);
  assert.equal(frame.itemSpacing, 40);
  assert.equal(find(frame, 'header').primaryAxisAlignItems, 'SPACE_BETWEEN');
  assert.equal(find(frame, 'header').counterAxisAlignItems, 'CENTER');
  assert.equal(find(frame, 'header').layoutSizingHorizontal, 'FILL');
  assert.equal(find(frame, 'nav').layoutMode, 'HORIZONTAL');
  assert.equal(find(frame, 'nav').itemSpacing, 24);
  assert.equal(find(frame, 'hero').topLeftRadius, 16);
  assert.equal(find(frame, 'hero').fills[0].type, 'SOLID');
  assert.equal(find(frame, 'card').strokeTopWeight, 1);
  assert.ok(flatten(frame).some(n => n.type === 'TEXT' && n.characters === 'HTML to Figma'));
  assert.equal(report.text, 13);
  assert.ok(report.autoLayout >= 9);
  assert.equal(report.total, flatten(frame).length);
  assert.ok(flatten(frame).some(n => n.name.endsWith('/ margin')));
  assert.ok(report.warnings.some(w => w.code === 'VIEWPORT_OVERFLOW'));
  assert.equal(frame.x, 1000 - frame.width / 2);
  assert.deepEqual(figma.currentPage.selection, [frame]);
  assert.deepEqual(figma.viewport.zoomed, [frame]);
  assert.ok(fontLoads.length > 0);
  assert.equal(new Set(fontLoads).size, fontLoads.length, 'font loads are cached');
  assert.equal(report.warnings.filter(w => w.code === 'NODE_FAILED').length, 0);
  await writeFile('test-results/mvp-intermediate.json', JSON.stringify(doc, null, 2));
});

test('real UI: file upload, mobile viewport, conversion message and report rendering', async () => {
  const page = await browser.newPage({ viewport: { width: 440, height: 760 } });
  try {
    await page.goto(`${base}/ui`);
    await page.evaluate(() => { window.addEventListener('message', event => { if (event.data?.pluginMessage?.type === 'CREATE_FIGMA') window.importMessage = event.data.pluginMessage; }); });
    assert.ok(await page.locator('#convert').isDisabled());
    await page.locator('#file').setInputFiles({ name: 'fixture.html', mimeType: 'text/html', buffer: Buffer.from('<style>body{margin:0}.page{display:flex;flex-direction:column;padding:16px;gap:12px}h1{margin:0}</style><main class="page"><h1>모바일 테스트</h1><button>편집하기</button></main>') });
    await page.locator('#convert').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('convert').disabled);
    await page.locator('#viewport').selectOption('375');
    assert.equal(await page.locator('#viewport-width').inputValue(), '375');
    assert.equal(await page.locator('#viewport-height').inputValue(), '900');
    await page.locator('#convert').click();
    await page.waitForFunction(() => !!window.importMessage);
    const message = await page.evaluate(() => window.importMessage);
    assert.equal(message.payload.root.size.width, 375);
    assert.equal(message.payload.options.viewportHeight, 900);
    const { report } = await convert(message.payload);
    await page.evaluate(({ requestId, report }) => window.postMessage({ pluginMessage: { type: 'COMPLETE', requestId, report } }, '*'), { requestId: message.requestId, report });
    await page.waitForFunction(() => document.getElementById('status').dataset.state === 'success');
    assert.equal(await page.locator('#text-count').textContent(), '2');
    assert.ok(await page.locator('#convert').isEnabled());
    assert.equal(await page.locator('#render-host iframe').count(), 0);
    await page.screenshot({ path: 'test-results/ui.png', fullPage: true });
  } finally { await page.close(); }
});

test('custom viewport inputs drive CSS viewport units, media queries and Figma width', async () => {
  const page = await browser.newPage({ viewport: { width: 440, height: 850 } });
  try {
    await page.goto(`${base}/ui`);
    await page.evaluate(() => { window.addEventListener('message', event => { if (event.data?.pluginMessage?.type === 'CREATE_FIGMA') window.importMessage = event.data.pluginMessage; }); });
    const html = '<style>body{margin:0}.page{display:flex;flex-direction:column}.measure{width:100vw;height:50vh}.responsive{display:none;margin:0}@media(min-width:1000px) and (min-height:650px){.responsive{display:block}}</style><main class="page"><div class="measure"><span>직접 입력 테스트</span></div><p class="responsive">반응형 조건 적용</p></main>';
    await page.locator('#file').setInputFiles({ name: 'custom.html', mimeType: 'text/html', buffer: Buffer.from(html) });
    await page.waitForFunction(() => !document.getElementById('convert').disabled);
    await page.locator('#viewport').selectOption('custom');
    for (const invalid of ['', '0', '-5', '10001', '12.5']) {
      await page.locator('#viewport-width').fill(invalid);
      assert.ok(await page.locator('#convert').isDisabled());
      assert.ok(await page.locator('#viewport-error').isVisible());
    }
    await page.locator('#viewport-width').fill('1111');
    await page.locator('#viewport-height').fill('0');
    assert.ok(await page.locator('#convert').isDisabled());
    await page.locator('#viewport-height').fill('777');
    assert.equal(await page.locator('#viewport').inputValue(), 'custom');
    assert.ok(await page.locator('#convert').isEnabled());
    assert.ok(await page.locator('#viewport-error').isHidden());
    await page.screenshot({ path: 'test-results/custom-viewport-ui.png', fullPage: true });
    await page.locator('#convert').click();
    assert.ok(await page.locator('#viewport-width').isDisabled());
    assert.ok(await page.locator('#viewport-height').isDisabled());
    await page.waitForFunction(() => !!window.importMessage);
    const message = await page.evaluate(() => window.importMessage);
    const doc = message.payload;
    assert.equal(doc.options.viewport, 1111);
    assert.equal(doc.options.viewportHeight, 777);
    const measure = parsedNodes(doc.root).find(node => node.name === 'measure');
    assert.equal(measure.size.width, 1111);
    assert.equal(measure.size.height, 388.5);
    assert.ok(parsedNodes(doc.root).some(node => node.text === '반응형 조건 적용'));
    assert.notEqual(doc.root.size.height, 777, 'frame height follows content rather than the rendering viewport');
    const { frame, report } = await convert(doc);
    assert.equal(frame.width, 1111);
    assert.equal(report.warnings.filter(w => w.code === 'NODE_FAILED').length, 0);
    await page.evaluate(({ requestId, report }) => window.postMessage({ pluginMessage: { type: 'COMPLETE', requestId, report } }, '*'), { requestId: message.requestId, report });
    await page.waitForFunction(() => !document.getElementById('viewport-width').disabled);
    await page.locator('#viewport').selectOption('1280');
    assert.equal(await page.locator('#viewport-width').inputValue(), '1280');
    assert.equal(await page.locator('#viewport-height').inputValue(), '900');
  } finally { await page.close(); }
});

test('unsafe HTML is inert; hidden elements are omitted; Grid/transform/pseudo are warnings', async () => {
  const html = `<style>body{margin:0}.page{display:flex;flex-direction:column}.grid{display:grid;grid-template-columns:1fr 1fr}.hidden{display:none}.pseudo::before{content:'prefix'}</style><script>parent.hacked=true</script><main class="page" onclick="parent.hacked=true"><p class="hidden">hidden</p><div class="grid"><span>A</span><span>B</span></div><div style="transform:rotate(4deg)">C</div><p class="pseudo">D</p><iframe srcdoc="<script>parent.hacked=true</script>"></iframe></main>`;
  const doc = await parse(html);
  const codes = new Set(doc.warnings.map(w => w.code));
  for (const code of ['SCRIPT_IGNORED', 'CSS_GRID', 'TRANSFORM', 'PSEUDO_ELEMENT', 'UNSUPPORTED_ELEMENT']) assert.ok(codes.has(code), code);
  assert.ok(!parsedNodes(doc.root).some(n => n.text === 'hidden'));
  const { report } = await convert(doc);
  assert.equal(report.warnings.filter(w => w.code === 'NODE_FAILED').length, 0);
});

test('absolute position is preserved outside flex flow; reverse/order and explicit dimensions work', async () => {
  const doc = await parse(`<style>body{margin:0}.page{position:relative;display:flex;flex-direction:row-reverse;gap:9px;width:500px;height:200px}.fixed{position:absolute;left:20px;top:30px;width:40px;height:50px}.fill{flex:1}.last{order:2}</style><main class="page"><div class="first" style="width:30px;height:60px"></div><div class="fill"></div><div class="last" style="width:70px;height:50px"></div><div class="fixed"></div></main>`, { viewport: 1280 });
  const { frame, report } = await convert(doc);
  assert.equal(frame.layoutMode, 'HORIZONTAL');
  assert.equal(frame.primaryAxisAlignItems, 'MAX');
  assert.equal(frame.children[0].name, 'last');
  assert.equal(find(frame, 'first').layoutSizingHorizontal, 'FIXED');
  assert.equal(find(frame, 'fill').layoutSizingHorizontal, 'FILL');
  assert.equal(find(frame, 'fixed').layoutPositioning, 'ABSOLUTE');
  assert.equal(find(frame, 'fixed').x, 20);
  assert.equal(find(frame, 'fixed').y, 30);
  assert.equal(report.warnings.filter(w => w.code === 'NODE_FAILED').length, 0);
});

test('image bytes become Image Fill; relative paths become editable placeholders', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const doc = await parse(`<style>body{margin:0}main{display:flex;gap:8px}img{width:40px;height:30px;object-fit:contain}</style><main><img id="ok" src="${image}"><img id="duplicate" src="${image}"><img id="missing" src="missing.png" alt="Missing"></main>`);
  assert.equal(Object.keys(doc.assets).length, 1);
  const { frame, report, images } = await convert(doc);
  assert.equal(find(frame, 'ok').fills[0].type, 'IMAGE');
  assert.equal(find(frame, 'ok').fills[0].scaleMode, 'FIT');
  assert.equal(find(frame, 'missing').fills[0].type, 'SOLID');
  assert.equal(images.length, 1);
  assert.equal(report.image, 3);
  assert.ok(report.warnings.some(w => w.code === 'IMAGE_PLACEHOLDER'));
});

test('font failures use a loadable fallback and do not abort sibling conversion', async () => {
  const doc = await parse('<style>body{margin:0}main{display:flex;flex-direction:column}p{font-family:Pretendard;margin:0}</style><main><p>문자 테스트</p><p>Second</p></main>');
  const fonts = [{ family: 'Pretendard', style: 'Regular' }, { family: 'Inter', style: 'Regular' }];
  const { frame, report } = await convert(doc, { fonts, failFonts: ['Pretendard'] });
  assert.equal(find(frame, 'p').fontName.family, 'Inter');
  assert.equal(report.text, 2);
  assert.ok(report.warnings.some(w => w.code === 'FONT_REPLACED'));
  const unavailable = await convert(doc, { fonts, failFonts: ['Pretendard', 'Inter'] });
  assert.equal(unavailable.report.text, 0);
  assert.ok(unavailable.report.warnings.some(w => w.code === 'FONT_UNAVAILABLE'));
});

test('CSS/Auto Layout toggles preserve text and fixed measured positioning', async () => {
  const doc = await parse('<style>body{margin:0}main{display:flex;background:red;padding:10px}p{color:blue;margin:0}</style><main><p>Test</p></main>', { autoLayout: false, styles: false });
  const { frame, report } = await convert(doc);
  assert.equal(frame.layoutMode, 'NONE');
  assert.deepEqual(frame.fills, []);
  assert.equal(find(frame, 'p').x, 10);
  assert.equal(find(frame, 'p').y, 10);
  assert.equal(report.autoLayout, 0);
  assert.equal(report.text, 1);
});

test('one node failure is reported; conversion remains usable and counts surviving nodes', async () => {
  const doc = await parse('<style>body{margin:0}main{display:flex}</style><main><span>bad text</span><span>good text</span></main>');
  const { frame, report, figma } = await convert(doc, { failText: 'bad text' });
  assert.equal(report.text, 1);
  assert.equal(report.total, flatten(frame).length);
  assert.ok(report.warnings.some(w => w.code === 'NODE_FAILED'));
  assert.equal(figma.currentPage.children.length, 1, 'no orphan nodes');
});

test('invalid messages and cancellation leave no partial imported frame', async () => {
  assert.throws(() => converter.validateDocument({ version: 2 }), /형식/);
  const doc = await parse(sample);
  const invalid = structuredClone(doc); invalid.root.size.width = NaN;
  assert.throws(() => converter.validateDocument(invalid), /크기/);
  for (const field of ['viewport', 'viewportHeight']) {
    for (const value of [0, -1, 1.5, 10001, NaN, Infinity, '1111', undefined]) {
      const invalidViewport = structuredClone(doc);
      invalidViewport.options[field] = value;
      assert.throws(() => converter.validateDocument(invalidViewport), /Viewport/);
    }
  }
  const mock = createFigmaMock(); globalThis.figma = mock.figma;
  let checks = 0;
  await assert.rejects(converter.convertDocument(doc, () => {}, () => ++checks > 5), /취소/);
  assert.equal(mock.figma.currentPage.children.length, 0);
});

test('body margins and absolute-only roots retain document geometry', async () => {
  const normal = await parse('<div style="width:100px;height:50px">Content</div>');
  const result = await convert(normal);
  assert.equal(result.frame.children[0].x, 8);
  assert.equal(result.frame.children[0].y, 8);
  const flex = await parse('<style>body{display:flex;flex-direction:column}</style><div style="width:100px;height:50px"></div>');
  const flexResult = await convert(flex);
  assert.equal(flexResult.frame.paddingLeft, 8);
  assert.equal(flexResult.frame.paddingTop, 8);
  const absolute = await parse('<style>body{margin:0;display:flex}</style><div style="position:absolute;left:10px;top:10px;width:20px;height:20px"></div>');
  assert.equal(absolute.root.size.heightMode, 'FIXED');
  const absoluteResult = await convert(absolute);
  assert.ok(absoluteResult.frame.height >= 30);
  assert.equal(absoluteResult.frame.children[0].layoutPositioning, 'ABSOLUTE');
});

test('plugin main entry receives CREATE_FIGMA and returns the completed report', async () => {
  const { runInNewContext } = await import('node:vm');
  const mock = createFigmaMock();
  const sent = [];
  mock.figma.ui.postMessage = message => sent.push(message);
  runInNewContext(await readFile('dist/code.js', 'utf8'), { figma: mock.figma, __html__: '<html></html>', setTimeout, Uint8Array, console });
  await mock.figma.ui.onmessage({ type: 'CREATE_FIGMA', requestId: 'main-entry', payload: await parse(sample) });
  assert.equal(sent.at(-1).type, 'COMPLETE');
  assert.equal(sent.at(-1).requestId, 'main-entry');
  assert.equal(sent.at(-1).report.text, 13);
  assert.equal(mock.figma.currentPage.children.length, 1);
});

test('large and deeply nested HTML stops at bounded editable tree limits', async () => {
  const large = await parse('<style>body{margin:0}</style>' + '<div style="width:10px;height:10px"></div>'.repeat(3100));
  assert.ok(parsedNodes(large.root).length <= 3000);
  assert.ok(large.warnings.some(w => w.code === 'TREE_LIMIT'));
  assert.doesNotThrow(() => converter.validateDocument(large));
  const deep = await parse('<style>body{margin:0}</style>' + '<div>'.repeat(100) + '<span style="background:red">deep</span>' + '</div>'.repeat(100));
  assert.ok(deep.warnings.some(w => w.code === 'TREE_LIMIT'));
  assert.doesNotThrow(() => converter.validateDocument(deep));
});

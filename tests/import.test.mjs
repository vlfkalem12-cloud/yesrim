import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createFigmaMock, flatten } from './figma-mock.mjs';

let browser, server, base, converter, parserBundle, utilities;
const sample = await readFile('examples/mvp.html', 'utf8');
before(async () => {
  await mkdir('test-results', { recursive: true });
  parserBundle = (await build({ entryPoints: ['src/parser.ts'], bundle: true, write: false, format: 'iife', globalName: 'Parser', target: 'es2020' })).outputFiles[0].text;
  await build({ entryPoints: ['src/converter.ts'], bundle: true, outfile: 'test-results/converter.mjs', format: 'esm', platform: 'node' });
  converter = await import('../test-results/converter.mjs');
  await build({ entryPoints: ['src/utils.ts'], bundle: true, outfile: 'test-results/utils.mjs', format: 'esm', platform: 'node' });
  utilities = await import('../test-results/utils.mjs');
  const ui = await readFile('dist/ui.html', 'utf8');
  server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url === '/ui' ? ui : '<!doctype html><html><body><div id="host"></div></body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const systemChromium = await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || systemChromium, headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
async function parse(html, overrides = {}, localAssets = {}, routes = {}) {
  const page = await browser.newPage();
  try {
    for (const [url, response] of Object.entries(routes)) await page.route(url, route => route.fulfill(response));
    await page.goto(base); await page.addScriptTag({ content: parserBundle });
    // Deep IR trees exceed Chromium's inspector object-return depth. Transfer the JSON artifact.
    const serialized = await page.evaluate(async ({ html, options, localAssets }) => JSON.stringify(await Parser.parseHTML(html, options, document.getElementById('host'), localAssets)), { html, localAssets, options: { viewport: 1440, viewportHeight: 900, autoLayout: true, styles: true, ...overrides } });
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
  for (const code of ['SCRIPT_IGNORED', 'TRANSFORM', 'PSEUDO_ELEMENT', 'UNSUPPORTED_ELEMENT']) assert.ok(codes.has(code), code);
  const grid = parsedNodes(doc.root).find(node => node.name === 'grid');
  assert.equal(grid.grid.supported, true);
  assert.equal(grid.layout.direction, 'VERTICAL');
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
  const fonts = [{ family: 'Pretendard', style: 'Regular' }, { family: 'Noto Sans KR', style: 'Regular' }, { family: 'Inter', style: 'Regular' }];
  const { frame, report } = await convert(doc, { fonts, failFonts: ['Pretendard'] });
  assert.equal(find(frame, 'p').fontName.family, 'Noto Sans KR');
  assert.equal(report.text, 2);
  assert.ok(report.warnings.some(w => w.code === 'FONT_REPLACED'));
  const unavailable = await convert(doc, { fonts, failFonts: ['Pretendard', 'Noto Sans KR', 'Inter'] });
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

test('phase 2 fixture preserves styles, vector SVG, Grid, constraints and diagnostic counts', async () => {
  const html = await readFile('test/phase2-test.html', 'utf8');
  const doc = await parse(html);
  const { frame, report } = await convert(doc);
  assert.equal(report.grid, 2);
  assert.equal(report.svg, 1);
  assert.equal(report.absolute, 2);
  assert.equal(report.image, 3);
  assert.ok(report.frames > 20);
  assert.ok(flatten(frame).some(node => node.type === 'VECTOR'));
  assert.ok(flatten(frame).some(node => node.type === 'TEXT' && node.characters.includes('한글 텍스트')));
  const styled = find(frame, 'styled-card');
  assert.equal(styled.strokeTopWeight, 0);
  assert.equal(styled.strokeRightWeight, 0);
  assert.equal(styled.strokeBottomWeight, 3);
  assert.equal(styled.strokeLeftWeight, 0);
  assert.equal(styled.topLeftRadius, 16);
  assert.equal(styled.topRightRadius, 16);
  assert.equal(styled.bottomLeftRadius, 0);
  assert.equal(styled.effects[0].type, 'DROP_SHADOW');
  assert.equal(styled.effects[0].radius, 12);
  assert.equal(styled.effects[0].offset.y, 4);
  assert.equal(styled.effects[0].color.a, .12);
  assert.equal(find(frame, 'fixed-column').width, 240);
  assert.equal(find(frame, 'fill-column').layoutSizingHorizontal, 'FILL');
  assert.equal(find(frame, 'fill-column').minWidth, 160);
  assert.equal(find(frame, 'fill-column').maxWidth, 1200);
  assert.equal(find(frame, 'clipped').clipsContent, true);
  assert.equal(find(frame, 'opacity-parent').opacity, .5);
  assert.equal(find(frame, 'opacity-child').opacity, .4);
  assert.equal(find(frame, 'card active selected hover'), undefined);
  assert.ok(!flatten(frame).some(node => node.type === 'TEXT' && /생성하면 안 되는/.test(node.characters)));
  assert.ok(doc.cssVariables.some(variable => variable.name === '--spacing-md' && variable.value === '16px'));
  assert.ok(report.warnings.some(warning => warning.code === 'GRID_FALLBACK' && warning.category === 'Grid Fallback'));
  assert.ok(report.warnings.some(warning => warning.code === 'UNSUPPORTED_CSS' && warning.element === 'div.unsupported'));
  assert.equal(report.warnings.filter(warning => warning.code === 'NODE_FAILED').length, 0);
  assert.equal(report.total, flatten(frame).length);
  assert.equal(report.frames, flatten(frame).filter(node => node.type === 'FRAME').length);
  assert.equal(Object.values(report.warningGroups).reduce((a, b) => a + b, 0), report.warnings.length);
  await writeFile('test-results/phase2-intermediate.json', JSON.stringify(doc, null, 2));
});

test('basic Grid track patterns use editable rows with Fill fr cells and Fixed px cells', async () => {
  for (const [template, count] of [['repeat(2, 1fr)', 2], ['repeat(3, 1fr)', 3], ['1fr 1fr', 2], ['200px 1fr', 2]]) {
    const doc = await parse(`<style>body{margin:0}main{display:flex;flex-direction:column}.grid{display:grid;grid-template-columns:${template};column-gap:24px;row-gap:16px}.card{display:flex;flex-direction:column;padding:8px;background:#eee;min-height:40px}</style><main><div class="grid">${'<div class="card"><span>Card</span></div>'.repeat(count + 1)}</div></main>`);
    const { frame, report } = await convert(doc);
    const grid = find(frame, 'grid');
    assert.equal(grid.layoutMode, 'VERTICAL', template);
    assert.equal(grid.itemSpacing, 16);
    assert.equal(grid.children.length, 2);
    for (const row of grid.children) {
      assert.equal(row.layoutMode, 'HORIZONTAL');
      assert.equal(row.itemSpacing, 24);
      assert.equal(row.children.length, count, 'last row retains empty tracks');
      assert.ok(row.children.every(cell => cell.layoutPositioning === 'AUTO'));
    }
    assert.equal(grid.children[0].children[0].layoutSizingHorizontal, template === '200px 1fr' ? 'FIXED' : 'FILL');
    if (template === '200px 1fr') assert.equal(grid.children[0].children[0].width, 200);
    assert.equal(grid.children[0].children[1].layoutSizingHorizontal, 'FILL');
    assert.equal(report.grid, 1);
    assert.equal(report.warnings.filter(warning => warning.code === 'NODE_FAILED').length, 0);
  }
});

test('absolute right/bottom anchors use parent coordinates; z-index keeps Auto Layout flow order', async () => {
  const doc = await parse('<style>body{margin:0}main{display:flex;flex-direction:column;padding:30px}.parent{position:relative;display:flex;width:300px;height:180px;border:2px solid black}.high{position:absolute;right:16px;bottom:20px;width:40px;height:30px;z-index:10}.low{position:absolute;left:12px;top:14px;width:40px;height:30px;z-index:1}</style><main><div class="parent"><span>flow</span><div class="high"></div><div class="low"></div></div></main>');
  const parentParsed = parsedNodes(doc.root).find(node => node.name === 'parent');
  const highParsed = parsedNodes(doc.root).find(node => node.name === 'high');
  const { frame, report } = await convert(doc);
  const parent = find(frame, 'parent'), high = find(frame, 'high'), low = find(frame, 'low');
  assert.equal(high.x, highParsed.rect.x - parentParsed.rect.x);
  assert.equal(high.y, highParsed.rect.y - parentParsed.rect.y);
  assert.deepEqual(high.constraints, { horizontal: 'MAX', vertical: 'MAX' });
  assert.ok(parent.children.indexOf(high) > parent.children.indexOf(low));
  assert.equal(parent.children[0].type, 'TEXT');
  assert.equal(report.absolute, 2);
  const reverse = await parse('<style>body{margin:0}main{display:flex}.a{position:relative;z-index:3}.b{position:relative;z-index:2}.c{position:relative;z-index:1}</style><main><span class="a">A</span><span class="b">B</span><span class="c">C</span></main>');
  const reversed = await convert(reverse);
  assert.deepEqual(reversed.frame.children.map(child => child.name), ['a', 'b', 'c']);
  assert.equal(reversed.frame.itemReverseZIndex, true);
});

test('relative image assets and backgrounds share PNG bytes; image/shadow options disable import', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const html = '<style>body{margin:0}main{display:flex}.bg{width:60px;height:40px;background:url(images/banner.png) center/contain no-repeat;box-shadow:0 4px 12px rgba(0,0,0,.12)}img{width:60px;height:40px}</style><main><img id="local" src="images/banner.png"><div class="bg"></div></main>';
  const doc = await parse(html, {}, { 'banner.png': png });
  assert.equal(Object.keys(doc.assets).length, 1);
  const { frame, images } = await convert(doc);
  assert.equal(find(frame, 'local').fills[0].type, 'IMAGE');
  assert.equal(find(frame, 'bg').fills[0].scaleMode, 'FIT');
  assert.equal(images.length, 1);
  assert.ok(!doc.warnings.some(warning => warning.code === 'IMAGE_LOAD'));
  const disabled = await parse(html, { images: false, shadows: false }, { 'banner.png': png });
  assert.deepEqual(disabled.assets, {});
  const off = await convert(disabled);
  assert.equal(off.images.length, 0);
  assert.ok(!find(off.frame, 'bg').effects?.length);
  assert.equal(off.report.image, 0);
});

test('HTTPS image responses with CORS produce Image Fill; CORS failures remain placeholders', async () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const html = '<style>body{margin:0}main{display:flex}img{width:30px;height:30px}</style><main><img id="cors-ok" src="https://assets.example.test/ok.png"><img id="cors-fail" src="https://assets.example.test/fail.png"></main>';
  const doc = await parse(html, {}, {}, { 'https://assets.example.test/ok.png': { contentType: 'image/png', body: bytes, headers: { 'Access-Control-Allow-Origin': '*' } }, 'https://assets.example.test/fail.png': { contentType: 'image/png', body: bytes, headers: { 'Access-Control-Allow-Origin': 'https://different.example.test' } } });
  const { frame, report } = await convert(doc);
  assert.equal(find(frame, 'cors-ok').fills[0].type, 'IMAGE');
  assert.equal(find(frame, 'cors-fail').fills[0].type, 'SOLID');
  assert.ok(report.warnings.some(warning => warning.code === 'IMAGE_LOAD' && warning.message.includes('https://assets.example.test/fail.png')));
});

test('SVG import failure preserves siblings and reports an editable Frame fallback', async () => {
  const doc = await parse('<style>body{margin:0}main{display:flex}svg{color:#2563eb}</style><main><svg class="icon" width="32" height="32" viewBox="0 0 32 32"><path d="M0 0h32v32z" fill="currentColor"/></svg><span>Sibling</span></main>');
  const svg = parsedNodes(doc.root).find(node => node.type === 'SVG');
  assert.ok(svg.svg.includes('rgb(37, 99, 235)'));
  assert.ok(!svg.svg.includes('currentColor'));
  const success = await convert(doc);
  assert.equal(success.report.svg, 1);
  assert.ok(flatten(success.frame).some(node => node.type === 'VECTOR'));
  const failure = await convert(doc, { failSvg: true });
  assert.equal(failure.report.text, 1);
  assert.ok(failure.report.warnings.some(warning => warning.code === 'SVG_IMPORT'));
  assert.equal(find(failure.frame, 'icon').type, 'FRAME');
});

test('wrapper optimization is conservative and debug names retain source selectors', async () => {
  const html = '<style>body{margin:0}p{margin:0}</style><main><div><p>Hello</p></div><div class="styled extra classes" style="padding:16px;background:#eee"><p>Keep</p></div></main>';
  const plain = await parse(html, { optimizeWrappers: false });
  const optimized = await parse(html, { optimizeWrappers: true, debug: true });
  assert.ok(parsedNodes(optimized.root).length < parsedNodes(plain.root).length);
  assert.ok(parsedNodes(optimized.root).some(node => node.name === 'styled'));
  const { frame } = await convert(optimized);
  assert.ok(flatten(frame).some(node => node.name === 'styled [div.styled.extra.classes]'));
  assert.ok(flatten(frame).some(node => node.type === 'TEXT' && node.characters === 'Hello'));
});

test('text transforms, pre whitespace and wrapping width remain editable', async () => {
  const doc = await parse('<style>body{margin:0}main{display:flex;flex-direction:column}.wrap{width:200px;line-height:24px;margin:0}.pre{width:100px;white-space:pre;margin:0}.caps{text-transform:capitalize;font-style:italic;text-decoration:line-through}</style><main><p class="wrap">Several words that wrap into multiple lines at the measured width.</p><p class="pre">first\n    second</p><span class="caps">hello world</span></main>');
  const { frame, report } = await convert(doc);
  const wrap = find(frame, 'wrap');
  assert.equal(wrap.width, 200);
  assert.equal(wrap.layoutSizingHorizontal, 'FIXED');
  assert.equal(wrap.lineHeight.value, 24);
  const pre = find(frame, 'pre / text');
  assert.equal(pre.characters, 'first\n    second');
  assert.equal(pre.layoutSizingHorizontal, 'HUG');
  assert.equal(find(frame, 'caps').characters, 'Hello World');
  assert.equal(find(frame, 'caps').textDecoration, 'STRIKETHROUGH');
  assert.equal(report.text, 3);
});

test('500 DOM items reuse loaded fonts and keep conversion counts consistent', async () => {
  const html = '<style>body{margin:0}main{display:flex;flex-direction:column;gap:4px}span{font-family:Inter}</style><main>' + '<span>Repeated editable content</span>'.repeat(500) + '</main>';
  const doc = await parse(html);
  const { frame, report, fontLoads } = await convert(doc);
  assert.equal(report.text, 500);
  assert.equal(report.total, flatten(frame).length);
  assert.equal(fontLoads.length, 1);
  assert.equal(report.warnings.filter(warning => warning.code === 'NODE_FAILED').length, 0);
});

test('color and shadow parsing supports hex, rgb, hsl and independent alpha', () => {
  const white = { r: 1, g: 1, b: 1, a: 1 };
  for (const value of ['#FFF', '#FFFFFF', 'rgb(255,255,255)', 'rgb(100% 100% 100%)', 'hsl(0,0%,100%)']) assert.deepEqual(utilities.parseColor(value), white, value);
  assert.deepEqual(utilities.parseColor('#0008'), { r: 0, g: 0, b: 0, a: 136 / 255 });
  assert.deepEqual(utilities.parseColor('rgba(255,0,0,.12)'), { r: 1, g: 0, b: 0, a: .12 });
  assert.deepEqual(utilities.parseColor('hsla(120,100%,50%,.4)'), { r: 0, g: 1, b: 0, a: .4 });
  assert.deepEqual(utilities.parseColor('hsl(.5turn 100% 50% / 50%)'), { r: 0, g: 1, b: 1, a: .5 });
  assert.equal(utilities.parseColor('transparent'), null);
  assert.equal(utilities.parseColor('rgba(bad)'), null);
  const shadow = utilities.parseShadow('rgba(0,0,0,.12) 0px 4px 12px 2px, rgba(0,0,0,.5) 1px 2px 3px');
  assert.deepEqual(shadow, { color: { r: 0, g: 0, b: 0, a: .12 }, x: 0, y: 4, blur: 12, spread: 2, inset: false });
});

test('sizing uses resolved flex basis/shrink and preserves unequal grow ratios with diagnostics', async () => {
  const doc = await parse('<style>body{margin:0}main{display:flex;flex-direction:column}.row{display:flex;width:400px;height:80px}.a,.b{flex-basis:300px;flex-shrink:1;min-width:0}.a{min-width:100px;max-width:250px}.b{min-height:20px;max-height:60px}.ratio{display:flex;width:600px}.one{flex:1;min-width:0}.two{flex:2;min-width:0}</style><main><div class="row"><div class="a"></div><div class="b"></div></div><div class="ratio"><div class="one"></div><div class="two"></div></div></main>');
  const a = parsedNodes(doc.root).find(node => node.name === 'a');
  assert.equal(a.layout.basis, '300px');
  assert.equal(a.layout.shrink, 1);
  assert.equal(a.size.width, 200);
  const { frame, report } = await convert(doc);
  assert.equal(find(frame, 'a').layoutSizingHorizontal, 'FIXED');
  assert.equal(find(frame, 'a').width, 200);
  assert.equal(find(frame, 'a').minWidth, 100);
  assert.equal(find(frame, 'a').maxWidth, 250);
  assert.equal(find(frame, 'b').minHeight, 20);
  assert.equal(find(frame, 'b').maxHeight, 60);
  assert.equal(find(frame, 'one').layoutSizingHorizontal, 'FIXED');
  assert.equal(find(frame, 'two').width, 400);
  assert.ok(report.warnings.some(warning => warning.code === 'FLEX_GROW_RATIO'));
});

test('UI exposes phase 2 options, local image upload, debug mode and grouped report', async () => {
  const page = await browser.newPage({ viewport: { width: 440, height: 1100 } });
  try {
    await page.goto(`${base}/ui`);
    for (const id of ['autolayout', 'images', 'shadows', 'optimize']) assert.ok(await page.locator(`#${id}`).isChecked());
    assert.ok(!await page.locator('#debug').isChecked());
    await page.evaluate(() => { window.addEventListener('message', event => { if (event.data?.pluginMessage?.type === 'CREATE_FIGMA') window.importMessage = event.data.pluginMessage; }); });
    await page.locator('#file').setInputFiles({ name: 'phase2.html', mimeType: 'text/html', buffer: await readFile('test/phase2-test.html') });
    await page.waitForFunction(() => !document.getElementById('convert').disabled);
    await page.locator('#asset-files').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
    await page.waitForFunction(() => document.getElementById('asset-count').textContent === '1개 선택');
    await page.locator('#debug').check();
    await page.locator('#convert').click();
    await page.waitForFunction(() => !!window.importMessage);
    const message = await page.evaluate(() => window.importMessage);
    assert.equal(message.payload.options.debug, true);
    assert.ok(!message.payload.warnings.some(warning => warning.code === 'IMAGE_SOURCE'));
    const { report } = await convert(message.payload);
    await page.evaluate(({ requestId, report }) => window.postMessage({ pluginMessage: { type: 'COMPLETE', requestId, report } }, '*'), { requestId: message.requestId, report });
    await page.waitForFunction(() => document.getElementById('status').dataset.state === 'success');
    assert.equal(await page.locator('#grid-count').textContent(), '2');
    assert.equal(await page.locator('#svg-count').textContent(), '1');
    assert.equal(await page.locator('#absolute-count').textContent(), '2');
    assert.ok((await page.locator('#warnings').textContent()).includes('Grid Fallback:'));
    await page.screenshot({ path: 'test-results/phase2-ui.png', fullPage: true });
  } finally { await page.close(); }
});

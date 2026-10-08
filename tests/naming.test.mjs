import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createFigmaMock, flatten } from './figma-mock.mjs';

let browser, server, url, parserBundle, namingBundle, converter, baselineParser, baselineConverter;
const baselineSource = process.env.NAMING_BASELINE_SRC;
const bundle = async (entry, name) => (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: name, target: 'es2020' })).outputFiles[0].text;
before(async () => {
  await mkdir('test-results', { recursive: true });
  parserBundle = await bundle('src/parser.ts', 'Parser');
  namingBundle = await bundle('src/layer-naming.ts', 'Naming');
  await build({ entryPoints: ['src/converter.ts'], bundle: true, outfile: 'test-results/naming-converter.mjs', format: 'esm', platform: 'node' });
  converter = await import('../test-results/naming-converter.mjs');
  if (baselineSource) {
    baselineParser = await bundle(resolve(baselineSource, 'parser.ts'), 'Parser');
    await build({ entryPoints: [resolve(baselineSource, 'converter.ts')], bundle: true, outfile: 'test-results/naming-baseline-converter.mjs', format: 'esm', platform: 'node' });
    baselineConverter = await import('../test-results/naming-baseline-converter.mjs');
  }
  server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><div id="host"></div>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH || await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });

async function parse(html, options = {}, code = parserBundle) {
  const page = await browser.newPage();
  try {
    await page.goto(url); await page.addScriptTag({ content: code });
    const result = await page.evaluate(async ({ html, options }) => JSON.stringify(await Parser.parseHTML(html, options, document.getElementById('host'))),
      { html, options: { viewport: 1440, viewportHeight: 900, autoLayout: true, styles: true, optimizeWrappers: false, ...options } });
    return JSON.parse(result);
  } finally { await page.close(); }
}
async function convert(doc, engine = converter) {
  const mock = createFigmaMock(); globalThis.figma = mock.figma;
  return { ...await engine.convertDocument(doc), ...mock };
}
const parsedNodes = node => [node, ...node.children.flatMap(parsedNodes)];
const withoutNames = doc => JSON.parse(JSON.stringify(doc, (key, value) => key === 'layerName' ? undefined : value));
function renderingSnapshot(node) {
  const properties = Object.fromEntries(Object.entries(node).filter(([key, value]) => !['id', 'name', 'parent', 'children'].includes(key) && typeof value !== 'function'));
  for (const key of ['fontName', 'characters', 'layoutSizingHorizontal', 'layoutSizingVertical', 'numberOfFixedChildren']) properties[key] = node[key];
  properties.metadata = Object.fromEntries(['html-source', 'html-type', 'html-grid', 'html-absolute', 'html-position', 'html-fixed-position', 'html-background-image', 'html-background-grid-line', 'html-background-grid-fallback', 'html-background-debug'].map(key => [key, node.getPluginData(key)]));
  properties.children = node.children.map(renderingSnapshot);
  return properties;
}

test('Naming priority uses accessibility, semantic text, labels, readable identifiers, meaningful classes and roles without mutating the DOM', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(url); await page.addScriptTag({ content: namingBundle });
    const result = await page.evaluate(() => {
      const cases = [
        ['<div id="user-management" class="card" aria-label="Main navigation">Other</div>', 'Main Navigation'],
        ['<header></header>', 'Header'], ['<nav></nav>', 'Navigation'], ['<main></main>', 'Main'], ['<aside></aside>', 'Sidebar'], ['<footer></footer>', 'Footer'],
        ['<nav class="nav"><span>Product</span><span>Guide</span><span>Contact</span></nav>', 'Navigation'],
        ['<form></form>', 'Form'], ['<table></table>', 'Table'], ['<table><thead></thead></table>', 'Table Header', 'thead'], ['<ul></ul>', 'List'],
        ['<button>저장</button>', 'Button / 저장'], ['<a>양도소득세</a>', 'Link / 양도소득세'],
        ['<div class="card p-4 d-flex align-items-center"><h3>오늘 업로드</h3><p>본문</p></div>', 'Card / 오늘 업로드'],
        ['<div class="summary-card"><span>오늘 업로드</span><span>128GB</span></div>', 'Card / 오늘 업로드'],
        ['<div class="traffic-widget"><div class="widget-header flex"><h3>트래픽</h3></div></div>', 'Widget / 트래픽'],
        ['<div id="traffic-chart"></div>', 'Traffic Chart'], ['<div id="user_management"></div>', 'User Management'], ['<div id="userManagement"></div>', 'User Management'],
        ['<div class="p-4 d-flex summary-card align-items-center"></div>', 'Summary Card'],
        ['<div class="hover:bg-white sm:flex px-4 traffic-widget"></div>', 'Traffic Widget'],
        ['<div class="flex items-center justify-between px-4 py-2 text-sm bg-white" role="dialog"></div>', 'Dialog'],
        ['<div class="custom-panel" role="navigation"></div>', 'Custom Panel'],
        ['<label for="email">Email</label><input id="email">', 'Input / Email', 'input'],
        ['<label for="country">Country</label><select id="country"><option>Japan</option></select>', 'Select / Country', 'select'],
        ['<label>Memo<textarea>Current value</textarea></label>', 'Textarea / Memo', 'textarea'],
        ['<input type="checkbox" id="save-info"><label for="save-info">Save this information</label>', 'Checkbox / Save this information', 'input'],
        ['<input type="radio" id="credit"><label for="credit">Credit card</label>', 'Radio / Credit card', 'input'],
        ['<input type="button" value="Cancel">', 'Button / Cancel', 'input'],
        ['<label for="aria">Label</label><input id="aria" aria-label="User email">', 'User Email', 'input'],
        ['<img alt="Bootstrap logo">', 'Image / Bootstrap Logo'], ['<img id="logo" alt="">', 'Image'],
        ['<svg width="24" height="24" aria-label="Search"></svg>', 'Icon / Search'], ['<svg width="24" height="24" class="download-icon"></svg>', 'Icon / Download'],
        ['<svg width="24" height="24"><title>Settings</title></svg>', 'Icon / Settings'], ['<svg width="24" height="24"></svg>', 'Icon'],
        ['<svg width="320" height="160"></svg>', 'Chart'], ['<svg width="24" height="24" id="traffic-chart"></svg>', 'Chart / Traffic'],
        ['<div class="traffic-chart"><svg width="120" height="64"></svg></div>', 'Chart', 'svg'],
        ['<div class="content-area"></div>', 'Content Area'], ['<div class="shadow-card"></div>', 'Shadow Card'],
        ['<div></div>', 'Container'], ['<div class="card"></div>', 'Card'], ['<div class="card"></div>', 'Card']
      ];
      const results = [];
      for (const [html, expected, selector] of cases) {
        const host = document.getElementById('host'); host.innerHTML = html;
        const element = selector ? host.querySelector(selector) : host.firstElementChild;
        const before = host.innerHTML, rect = element.getBoundingClientRect();
        const type = element.localName === 'svg' ? 'SVG' : element.localName === 'img' ? 'IMAGE' : 'FRAME';
        const actual = Naming.generateLayerName(element, { type, width: Number(element.getAttribute('width')) || rect.width, height: Number(element.getAttribute('height')) || rect.height });
        results.push({ html, actual, expected, unchanged: host.innerHTML === before });
      }
      return results;
    });
    for (const { html, actual, expected, unchanged } of result) { assert.equal(actual, expected, html); assert.equal(unchanged, true, html); }
  } finally { await page.close(); }
});

test('Utility filters, name length, body-text exclusion, displayed Text naming and Debug candidates are bounded', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(url); await page.addScriptTag({ content: namingBundle });
    const result = await page.evaluate(() => {
      const utilities = ['d-flex', 'flex-column', 'align-items-center', 'justify-content-between', 'p-4', 'px-3', 'mt-2', 'mb-3', 'w-100', 'h-100', 'col-md-6', 'row', 'g-3', 'flex', 'items-center', 'justify-between', 'px-4', 'py-2', 'text-sm', 'bg-white', 'sm:grid-cols-2', 'hover:bg-blue-500', '-mt-2', 'w-[220px]', 'shadow-lg', 'overflow-y-auto'];
      const meaningfulClasses = ['card', 'summary-card', 'traffic-widget', 'quick-links', 'sidebar', 'navigation', 'toolbar', 'modal', 'dialog', 'badge', 'button-group', 'error-state', 'content-area', 'shadow-card', 'overflow-inner', 'list-group'];
      const host = document.getElementById('host');
      host.innerHTML = '<div class="summary-card"><span>오늘 업로드</span></div>';
      const candidates = []; const name = Naming.generateLayerName(host.firstElementChild, { type: 'FRAME', debug: value => candidates.push(value) });
      const longText = '이 문장은 매우 긴 본문입니다. 여러 문장과 자세한 설명을 포함하며 레이어 제목으로 전체를 사용하면 안 됩니다.';
      host.innerHTML = `<div class="card"><p>${longText}</p></div>`;
      const paragraphCard = Naming.generateLayerName(host.firstElementChild, { type: 'FRAME' });
      const textName = Naming.generateLayerName(host.querySelector('p'), { type: 'TEXT', text: longText });
      host.firstElementChild.setAttribute('aria-label', '엄청 긴 이름 '.repeat(15));
      const longName = Naming.generateLayerName(host.firstElementChild, { type: 'FRAME' });
      return { utilities: utilities.map(name => [name, Naming.isUtilityClass(name)]), classes: meaningfulClasses.map(name => [name, Naming.isUtilityClass(name)]),
        name, candidates, paragraphCard, textName, longText, longName, pureText: Naming.generateLayerName(host.querySelector('p'), { type: 'TEXT', text: '저장소 사용량' }) };
    });
    for (const [name, utility] of result.utilities) assert.equal(utility, true, name);
    for (const [name, utility] of result.classes) assert.equal(utility, false, name);
    assert.equal(result.name, 'Card / 오늘 업로드'); assert.equal(result.candidates[0].tag, 'div'); assert.equal(result.candidates[0].meaningfulClass, 'summary-card');
    assert.equal(result.candidates[0].text, '오늘 업로드'); assert.equal(result.candidates[0].final, result.name);
    assert.equal(result.paragraphCard, 'Card'); assert.notEqual(result.textName, result.longText); assert.ok([...result.textName].length <= 40);
    assert.ok([...result.longName].length <= 40); assert.ok(result.longName.endsWith('…')); assert.equal(result.pureText, '저장소 사용량');
  } finally { await page.close(); }
});

test('Named Dashboard/Form layers retain text, native SVG and Image content and existing synthetic wrappers', async () => {
  const doc = await parse(await readFile('test/layer-naming-regression.html', 'utf8')), { frame, report } = await convert(doc);
  const nodes = flatten(frame), names = nodes.map(node => node.name);
  for (const name of ['Dashboard', 'Main Navigation', 'Card / 오늘 업로드', 'Card / 저장소 사용량', 'Widget / 업로드 다운로드 트래픽', 'Chart / Traffic',
    'Quick Links', '양도소득세', 'Input / Email', 'Select / Country', 'Textarea / Memo', 'Checkbox / Save this information', 'Radio / Credit card',
    'Button / 저장', 'Button / Cancel', 'Search', 'Icon / Search', 'Icon / Download', 'Icon / Settings', 'Image / Bootstrap Logo', 'Modal / 확인']) assert.ok(names.includes(name), name);
  assert.equal(names.filter(name => name === 'Card / 저장소 사용량').length, 2, 'duplicates receive no artificial suffix');
  assert.ok(nodes.some(node => node.name === 'Grid Row')); assert.ok(nodes.some(node => node.name.startsWith('Grid Cell / Card /')));
  const input = nodes.find(node => node.name === 'Input / Email'); assert.equal(input.children[0].characters, '김'); assert.equal(input.children[0].name, '김');
  assert.equal(nodes.find(node => node.name === 'Select / Country').children[0].characters, '대한민국');
  assert.equal(nodes.find(node => node.name === 'Textarea / Memo').children[0].characters, '현재 메모');
  const image = nodes.find(node => node.name === 'Image / Bootstrap Logo'); assert.equal(image.fills[0].type, 'IMAGE');
  const chart = nodes.find(node => node.name === 'Chart / Traffic'); assert.ok(chart.children.some(node => node.type === 'VECTOR'));
  assert.equal(report.svg, 4); assert.equal(report.grid, 1);
  assert.ok(!names.some(name => ['div', 'span', 'a', 'svg', 'input'].includes(name)));
});

test('Naming leaves every non-name conversion field identical across Landing, Dashboard, Admin/Form, Grid, Gradient, SVG and rendering fixtures', async () => {
  const fixtures = ['examples/mvp.html', 'test/dashboard-rendering-regression.html', 'test/form-controls-regression.html', 'test/fixed-position-regression.html',
    'test/phase2-test.html', 'test/rendering-regression.html', 'test/gradient-regression.html', 'test/inline-accessibility-regression.html', 'test/layer-naming-regression.html'];
  const results = [];
  for (const fixture of fixtures) {
    const html = await readFile(fixture, 'utf8'), doc = await parse(html);
    const baselineDoc = baselineParser ? await parse(html, {}, baselineParser) : withoutNames(doc);
    assert.deepEqual(withoutNames(doc), baselineDoc, `${fixture}: parser data differs beyond naming metadata`);
    const previous = await convert(baselineDoc, baselineConverter || converter), current = await convert(doc);
    assert.deepEqual(renderingSnapshot(current.frame), renderingSnapshot(previous.frame), `${fixture}: a non-name node field changed`);
    assert.deepEqual(current.svgImports, previous.svgImports, `${fixture}: SVG bytes changed`);
    assert.deepEqual(current.images, previous.images, `${fixture}: image bytes changed`);
    assert.deepEqual({ ...current.report, durationMs: 0 }, { ...previous.report, durationMs: 0 }, `${fixture}: conversion report changed`);
    const nodes = flatten(current.frame);
    results.push({ fixture, parsedNodes: parsedNodes(doc.root).length, createdNodes: nodes.length,
      renamedNodes: nodes.filter(node => node.name !== node.originalName).length, nonNameFieldsEqual: true, svgBytesEqual: true, imageBytesEqual: true });
  }
  await writeFile('test-results/layer-naming-regression.json', JSON.stringify({ baseline: baselineSource ? 'pre-change engine' : 'same document without naming metadata', results }, null, 2));
});

test('Name application retains all anonymous wrappers and handles Auto Layout off, Debug selectors and legacy JSON', async () => {
  const html = '<style>body{margin:0}main{display:flex;flex-direction:column}.card{padding:12px}p{margin:0}</style><main><div><div><p>Keep wrappers</p></div></div><div class="card"><h3>Title</h3></div></main>';
  for (const autoLayout of [true, false]) {
    const doc = await parse(html, { autoLayout }), result = await convert(doc);
    assert.equal(flatten(result.frame).filter(node => node.type === 'FRAME' && node.getPluginData('html-source') === 'div').length, 2);
    const legacy = await convert(withoutNames(doc));
    assert.deepEqual(renderingSnapshot(result.frame), renderingSnapshot(legacy.frame));
  }
  const doc = await parse(html), debug = await convert({ ...doc, options: { ...doc.options, debug: true } });
  assert.ok(flatten(debug.frame).some(node => node.name === 'Card / Title [div.card]'));
  assert.ok(flatten(debug.frame).some(node => node.name === 'Keep wrappers [p]'));
  const invalid = structuredClone(doc); invalid.root.layerName = 42;
  await assert.rejects(() => convert(invalid), /Layer Name/);
  assert.equal(globalThis.figma.currentPage.children.length, 0);
});

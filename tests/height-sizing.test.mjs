import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createFigmaMock, flatten } from './figma-mock.mjs';

let browser, server, url, parser, converter, baselineParser, baselineConverter;
const baselineSource = process.env.HEIGHT_BASELINE_SRC;
const bundle = async entry => (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'Parser', target: 'es2020' })).outputFiles[0].text;
before(async () => {
  await mkdir('test-results', { recursive: true }); parser = await bundle('src/parser.ts');
  await build({ entryPoints: ['src/converter.ts'], bundle: true, outfile: 'test-results/height-converter.mjs', format: 'esm', platform: 'node' });
  converter = await import('../test-results/height-converter.mjs');
  if (baselineSource) {
    baselineParser = await bundle(resolve(baselineSource, 'parser.ts'));
    await build({ entryPoints: [resolve(baselineSource, 'converter.ts')], bundle: true, outfile: 'test-results/height-baseline-converter.mjs', format: 'esm', platform: 'node' });
    baselineConverter = await import('../test-results/height-baseline-converter.mjs');
  }
  server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><div id="host"></div>'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); url = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH || await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(done => server ? server.close(done) : done()); });
async function parse(html, options = {}, code = parser) {
  const page = await browser.newPage();
  try {
    await page.goto(url); await page.addScriptTag({ content: code });
    return JSON.parse(await page.evaluate(async ({ html, options }) => JSON.stringify(await Parser.parseHTML(html, options, document.getElementById('host'))),
      { html, options: { viewport: 1440, viewportHeight: 900, autoLayout: true, styles: true, optimizeWrappers: false, ...options } }));
  } finally { await page.close(); }
}
async function convert(doc, options = {}, engine = converter) {
  const mock = createFigmaMock(options); globalThis.figma = mock.figma;
  return { ...await engine.convertDocument(doc), ...mock };
}
const nodes = node => [node, ...node.children.flatMap(nodes)];
const source = (doc, name) => nodes(doc.root).find(node => node.name === name);
const find = (frame, name) => flatten(frame).find(node => node.originalName === name || node.name === name);
const fixture = () => readFile('test/height-sizing-regression.html', 'utf8');
const documentFor = content => `<style>*{box-sizing:border-box}body{margin:0}main{display:flex;flex-direction:column;gap:12px}</style><main>${content}</main>`;
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1, `${label}: ${a} vs ${b}`);

async function measureWrap(node, counts) {
  // Independent Chromium layout from the Figma API properties, never the parser's height calculation.
  const page = await browser.newPage();
  try {
    await page.goto(url);
    return await page.evaluate(({ row, counts }) => {
      const result = [];
      for (const count of counts) {
        const parent = document.createElement('div');
        Object.assign(parent.style, { display: 'flex', flexWrap: row.wrap === 'WRAP' ? 'wrap' : 'nowrap', width: `${row.width}px`, boxSizing: 'border-box',
          height: row.mode === 'HUG' ? 'auto' : `${row.height}px`, columnGap: `${row.gap}px`, rowGap: `${row.rowGap}px` });
        for (let index = 0; index < count; index++) { const child = document.createElement('div'); Object.assign(child.style, { flex: 'none', width: `${row.children[index % row.children.length].width}px`, height: `${row.children[index % row.children.length].height}px` }); parent.append(child); }
        document.body.append(parent); const box = parent.getBoundingClientRect();
        result.push({ count, height: box.height, children: [...parent.children].map(child => { const c = child.getBoundingClientRect(); return { x: c.x - box.x, y: c.y - box.y, width: c.width, height: c.height }; }) }); parent.remove();
      }
      return result;
    }, { row: { width: node.width, height: node.height, mode: node.layoutSizingVertical, wrap: node.layoutWrap, gap: node.itemSpacing || 0, rowGap: node.counterAxisSpacing || 0, children: node.children.map(child => ({ width: child.width, height: child.height })) }, counts });
  } finally { await page.close(); }
}

test('Author auto/absent declarations remain distinct from identical computed pixel heights and min/max constraints', async () => {
  const html = documentFor('<style>.auto{height:auto}.fixed{height:100px}.auto,.absent,.fixed{display:flex;flex-direction:column}.auto>div,.absent>div,.fixed>div{height:100px}</style><div id="auto" class="auto"><div></div></div><div id="absent" class="absent"><div></div></div><div id="fixed" class="fixed"><div></div></div><div id="inline" style="display:flex;height:100px"><div></div></div>');
  const doc = await parse(html), { frame } = await convert(doc);
  for (const name of ['auto', 'absent', 'fixed', 'inline']) {
    const node = source(doc, name); assert.equal(node.size.heightSource.computedHeight, '100px'); assert.equal(node.size.heightSource.renderedHeight, 100);
    assert.equal(node.size.height, 100); assert.equal(find(frame, name).height, 100);
  }
  for (const name of ['auto', 'absent']) { assert.equal(source(doc, name).size.heightIntent, 'auto'); assert.equal(find(frame, name).layoutSizingVertical, 'HUG'); }
  for (const name of ['fixed', 'inline']) { assert.equal(source(doc, name).size.heightIntent, 'fixed'); assert.equal(find(frame, name).layoutSizingVertical, 'FIXED'); }
  assert.equal(source(doc, 'inline').size.heightSource.inlineHeight, '100px'); assert.equal(source(doc, 'absent').size.heightSource.inlineHeight, '');
});

test('Six flex:1 1 360px cards keep 3×2 rows, original widths and 700px while their existing parent hugs', async () => {
  const doc = await parse(await fixture()), result = await convert(doc, { simulateAutoHeight: true });
  const container = source(doc, 'card-list'), target = find(result.frame, 'card-list');
  assert.equal(container.size.authoredHeight, 'auto'); assert.equal(container.size.heightSource.computedHeight, '700px');
  assert.equal(container.children.length, 6); assert.equal(container.layout.wrap, true); assert.equal(container.layout.direction, 'HORIZONTAL');
  assert.equal(target.layoutWrap, 'WRAP'); assert.equal(target.counterAxisSpacing, 20); assert.equal(target.layoutSizingVertical, 'HUG');
  assert.equal(target.height, 700); assert.equal(target.children.length, 6, 'no extra row wrappers');
  for (const [index, child] of target.children.entries()) { assert.equal(child.width, container.children[index].size.width); assert.equal(child.height, 340); assert.equal(child.minHeight, 340); }
  const [measured] = await measureWrap(target, [6]); near(measured.height, container.size.heightSource.renderedHeight, 'original visual height');
  for (const [index, child] of measured.children.entries()) {
    near(child.x, container.children[index].rect.x - container.rect.x, 'original column x'); near(child.y, container.children[index].rect.y - container.rect.y, 'original row y');
  }
  assert.ok(!result.report.warnings.some(warning => warning.code === 'FLEX_WRAP' && warning.node === 'card-list'));
  await writeFile('test-results/height-intermediate.json', JSON.stringify(doc, null, 2));
});

test('Appending and deleting children changes Hug height instead of retaining the initial fixed px value', async () => {
  const { frame, figma } = await convert(await parse(await fixture()), { simulateAutoHeight: true }), parent = find(frame, 'card-list');
  const projection = await measureWrap(parent, [6, 7, 6, 3]);
  const newCard = figma.createFrame(); newCard.resize(parent.children[0].width, 340); parent.appendChild(newCard);
  assert.equal(parent.height, 1060); near(parent.height, projection[1].height, 'new wrapped row grows parent');
  newCard.remove(); assert.equal(parent.height, 700); near(parent.height, projection[2].height, 'remove row shrinks parent');
  for (const child of [...parent.children].slice(3)) child.remove(); assert.equal(parent.height, 340); near(parent.height, projection[3].height, 'one row remains');
  const column = find(frame, 'column'), initial = column.height;
  const child = figma.createFrame(); child.resize(100, 50); column.appendChild(child);
  assert.equal(column.height, initial + 50 + 12); child.remove(); assert.equal(column.height, initial);
});

test('Mobile Root 360×844 stays Fixed while middle content fills and question Wrap hugs with unchanged Rich Text', async () => {
  const html = `<style>*{box-sizing:border-box}body{margin:0}#mobile{display:flex;flex-direction:column;width:360px;height:844px}#header{height:60px;flex-shrink:0}#content{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;padding:12px;gap:8px}#questions{display:flex;flex-wrap:wrap;gap:8px}.question{width:152px;flex:none;padding:8px 10px;font:12.5px/1.4 'Noto Sans KR',sans-serif}.question a{display:block}.question svg{margin-right:5px;vertical-align:-1px}b{font-weight:600}#input{display:flex;align-items:center;padding:8px;height:56px;flex-shrink:0}input{height:40px}#home{height:20px;flex-shrink:0}</style><main id="mobile"><div id="header"></div><div id="content"><div id="questions">${Array.from({ length: 6 }, (_, index) => `<div class="question" id="q-${index}"><a><svg width="11" height="11" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#0B7A6E"/></svg><b>양도</b> 집 한 채면 팔아도 세금이 없나요?</a></div>`).join('')}</div></div><div id="input"><input value="김"></div><div id="home"></div></main>`;
  const doc = await parse(html, { viewport: 360, viewportHeight: 844 }), result = await convert(doc);
  assert.equal(doc.root.size.authoredHeight, '844px'); assert.equal(doc.root.size.heightMode, 'FIXED'); assert.equal(doc.root.size.height, 844);
  assert.deepEqual([result.frame.width, result.frame.height, result.frame.layoutSizingVertical], [360, 844, 'FIXED']);
  assert.equal(source(doc, 'content').size.heightMode, 'FILL'); assert.equal(find(result.frame, 'content').layoutSizingVertical, 'FILL');
  assert.equal(find(result.frame, 'questions').layoutSizingVertical, 'HUG'); assert.equal(find(result.frame, 'questions').layoutWrap, 'WRAP');
  const question = find(result.frame, 'q-0'), sentence = flatten(question).find(node => node.type === 'TEXT');
  assert.equal(sentence.characters, '양도 집 한 채면 팔아도 세금이 없나요?'); assert.equal(sentence.textAutoResize, 'HEIGHT');
  assert.equal(sentence.layoutSizingHorizontal, 'FILL'); assert.equal(sentence.getRangeFontName(0, 2).style, 'Bold');
  assert.equal(result.svgImports.length, 6); assert.equal(find(result.frame, 'input').height, 56);
  assert.ok(!result.report.warnings.some(warning => warning.code === 'SIZING_CYCLE' && warning.node === 'Imported HTML'));
});

test('Explicit Chart/root heights, clipped/scrolled regions, viewport and percentage heights keep rendered sizes', async () => {
  const doc = await parse(await fixture()), { frame } = await convert(doc, { simulateAutoHeight: true });
  for (const [name, height] of [['chart-wrap', 280], ['clipped', 76], ['scrolling', 100]]) { assert.equal(source(doc, name).size.heightMode, 'FIXED'); assert.equal(find(frame, name).layoutSizingVertical, 'FIXED'); assert.equal(find(frame, name).height, height); }
  assert.equal(find(frame, 'clipped').clipsContent, true); assert.equal(find(frame, 'scrolling').clipsContent, true);
  const other = await parse(documentFor('<div id="vh" style="display:flex;flex-direction:column;height:50vh"><div style="height:20px"></div></div><div id="percent-parent" style="height:200px"><div id="percent" style="height:50%"></div></div><svg id="attribute" width="30" height="40"></svg>'));
  assert.equal(source(other, 'vh').size.heightIntent, 'viewport'); assert.equal(source(other, 'vh').size.heightMode, 'FIXED');
  assert.equal(source(other, 'percent').size.heightIntent, 'percent'); assert.equal(source(other, 'percent').size.height, 100);
  assert.equal(source(other, 'attribute').size.heightIntent, 'fixed'); assert.equal(source(other, 'attribute').size.height, 40);
  const root = await parse('<style>body{margin:0}main{height:844px;display:flex;flex-direction:column;overflow:hidden}.child{height:1000px;flex-shrink:0}</style><main><div class="child"></div></main>', { viewport: 360 });
  assert.equal(root.root.size.height, 844, 'overflow does not enlarge explicit root to document height'); assert.equal(root.root.size.heightMode, 'FIXED');
});

test('Safe normal flow, min/max and Grid contents hug while Stretch and Absolute/Fixed stay in their existing policies', async () => {
  const doc = await parse(await fixture()), { frame } = await convert(doc, { simulateAutoHeight: true });
  assert.equal(find(frame, 'normal-flow').layoutSizingVertical, 'HUG'); assert.equal(find(frame, 'normal-flow').height, 60);
  assert.equal(find(frame, 'grid').layoutSizingVertical, 'HUG'); assert.equal(find(frame, 'grid').height, source(doc, 'grid').size.heightSource.renderedHeight);
  assert.equal(find(frame, 'min-height').layoutSizingVertical, 'HUG'); assert.equal(find(frame, 'min-height').minHeight, 100); assert.equal(find(frame, 'min-height').height, 100);
  const anonymous = await parse('<style>body{margin:0;background:#fff}</style><div style="padding:10px"><div style="height:30px"></div></div>');
  const anonymousResult = await convert(anonymous, { simulateAutoHeight: true });
  assert.equal(anonymousResult.frame.layoutSizingVertical, 'HUG'); assert.equal(anonymousResult.frame.children[0].layoutSizingVertical, 'HUG');
  assert.equal(anonymousResult.frame.height, 50); assert.equal(anonymousResult.frame.children.length, 1, 'styled anonymous wrapper retained');
  const html = documentFor('<div id="stretch" style="display:flex;height:120px"><div id="stretch-child" style="display:flex;flex-direction:column"><div style="height:20px"></div></div></div><div id="position" style="position:relative;height:160px"><div id="absolute" style="position:absolute;right:0;bottom:0;height:76px;display:flex"><div></div></div><div id="fixed" style="position:fixed;left:240px;right:0;bottom:0;height:76px;display:flex"><div></div></div></div>');
  const positionDoc = await parse(html), result = await convert(positionDoc);
  assert.equal(source(positionDoc, 'stretch-child').size.heightMode, 'FILL'); assert.equal(find(result.frame, 'stretch-child').layoutSizingVertical, 'FILL');
  assert.equal(source(positionDoc, 'absolute').layout.absolute, true); assert.equal(find(result.frame, 'absolute').getPluginData('html-absolute'), 'true');
  assert.equal(find(result.frame, 'position').height - find(result.frame, 'absolute').y - find(result.frame, 'absolute').height, 0);
  assert.deepEqual([find(result.frame, 'fixed').x, find(result.frame, 'fixed').y, find(result.frame, 'fixed').width, find(result.frame, 'fixed').height], [240, 824, 1200, 76]);
});

test('Complex/reverse Wrap, negative margins, disabled Auto Layout and rejected Wrap API retain measured children instead of dropping them', async () => {
  for (const css of ['flex-direction:column;height:100px', 'flex-direction:row-reverse', 'flex-wrap:wrap-reverse', 'align-content:center;min-height:1000px']) {
    const html = documentFor(`<div id="complex" style="display:flex;flex-wrap:wrap;gap:10px;width:300px;${css}">${'<div style="width:120px;height:40px"></div>'.repeat(5)}</div>`);
    const doc = await parse(html), result = await convert(doc), target = find(result.frame, 'complex');
    assert.equal(target.layoutMode, 'NONE'); assert.equal(target.children.length, 5); assert.equal(target.height, source(doc, 'complex').size.height);
    for (const [index, child] of target.children.entries()) { assert.equal(child.x, source(doc, 'complex').children[index].rect.x - source(doc, 'complex').rect.x); assert.equal(child.y, source(doc, 'complex').children[index].rect.y - source(doc, 'complex').rect.y); }
  }
  const negative = await parse(documentFor(`<div id="negative" style="display:flex;flex-wrap:wrap;width:300px;gap:10px">${'<div style="width:120px;height:40px;margin-left:-4px"></div>'.repeat(5)}</div>`));
  assert.equal(source(negative, 'negative').layout.direction, 'NONE');
  const huggingText = await parse(documentFor('<div id="text-wrap" style="display:flex;flex-wrap:wrap;width:300px;gap:10px"><span>A</span><span>B</span></div>'));
  assert.equal(source(huggingText, 'text-wrap').layout.direction, 'NONE', 'native Wrap cannot alter existing intrinsic Text width');
  // Preserve source rows when the old viewport override expands a hard-coded page width.
  const changedViewport = await parse(await fixture(), { viewport: 1600 });
  assert.equal(source(changedViewport, 'card-list').layout.direction, 'NONE'); assert.equal(source(changedViewport, 'card-list').size.height, 700);
  assert.match(source(changedViewport, 'card-list').size.heightSource.reason, /Viewport width changes Wrap rows/);
  const html = await fixture();
  for (const [options, mock] of [[{ autoLayout: false }, {}], [{}, { failWrap: true }]]) {
    const doc = await parse(html, options), result = await convert(doc, mock), parent = find(result.frame, 'card-list');
    assert.equal(parent.layoutMode, 'NONE'); assert.equal(parent.height, 700); assert.equal(parent.children.length, 6);
    assert.ok(!result.report.warnings.some(warning => warning.code === 'NODE_FAILED'));
    if (mock.failWrap) assert.ok(result.report.warnings.some(warning => warning.code === 'HEIGHT_LAYOUT'));
  }
});

test('Root Hug survives the final viewport resize and Wrap padding/border contribute to native content height', async () => {
  const doc = await parse(await fixture()), { frame } = await convert(doc, { simulateAutoHeight: true, resizeResetsHug: true });
  assert.equal(frame.layoutSizingVertical, 'HUG');
  const html = (await fixture()).replace('#card-list { display: flex; flex-wrap: wrap; gap: 20px; }', '#card-list { display: flex; flex-wrap: wrap; gap: 20px; padding:12px 14px; border:2px solid #CCD4E0; }');
  const paddedDoc = await parse(html), result = await convert(paddedDoc, { simulateAutoHeight: true }), padded = find(result.frame, 'card-list');
  assert.equal(padded.layoutSizingVertical, 'HUG');
  assert.equal(padded.height, source(paddedDoc, 'card-list').size.heightSource.renderedHeight);
  assert.equal(padded.height, 1088, '3 rows of 340 + 2 gaps of 20 + padding 24 + border 4');
});

test('Debug report exposes author intent/rendered size/final mode; malformed metadata fails before allocating nodes; legacy JSON stays usable', async () => {
  const doc = await parse(await fixture(), { debug: true }), result = await convert(doc);
  for (const [name, mode, authored] of [['card-list', 'HUG', 'auto'], ['chart-wrap', 'FIXED', '280px']]) {
    const target = flatten(result.frame).find(node => node.getPluginData('html-source') === `section#${name}` || node.getPluginData('html-source') === `div#${name}`);
    const details = JSON.parse(target.getPluginData('html-height-sizing')); assert.equal(details.mode, mode); assert.equal(details.authoredHeight, authored);
    assert.equal(details.renderedHeight, source(doc, name).rect.height);
  }
  assert.ok(result.report.warnings.some(warning => warning.code === 'HEIGHT_SIZING' && warning.category === 'Debug'));
  for (const mutate of [node => { node.size.heightIntent = 'invalid'; }, node => { node.size.heightSource.renderedHeight = NaN; }, node => { node.layout.wrapSpacing = -1; }]) {
    const bad = structuredClone(doc); mutate(source(bad, 'card-list')); const mock = createFigmaMock(); globalThis.figma = mock.figma;
    await assert.rejects(() => converter.convertDocument(bad), /Height|Wrap Sizing/); assert.equal(mock.figma.currentPage.children.length, 0);
  }
  const legacy = structuredClone(doc); for (const node of nodes(legacy.root)) { delete node.size.heightIntent; delete node.size.heightSource; }
  assert.equal((await convert(legacy)).report.text, result.report.text);
});

function withoutHeight(doc) {
  const copy = structuredClone(doc);
  for (const node of nodes(copy.root)) {
    // Explicitly permit only the intentional height/layout change on eligible containers.
    if (node.layout.normalFlow || (node.size.heightSource && ['Measured vertical normal flow', 'Content-driven horizontal Wrap'].includes(node.size.heightSource.reason))) node.layout.direction = 'NONE';
    delete node.size.heightSource; delete node.size.heightIntent; delete node.size.heightMode; delete node.layout.wrapSpacing; delete node.layout.normalFlow;
  }
  return copy;
}
function unaffectedPaints(node, parsedFrames) {
  const parsed = parsedFrames.get(node.getPluginData('html-source')), padding = parsed?.layout.padding;
  // Verified block flow intentionally encodes collapsed edge margins in API padding. CSS padding stays unchanged in the JSON comparison.
  const sourcePadding = parsed?.layout.normalFlow ? padding : undefined;
  return { name: node.name, type: node.type, width: node.width, fills: node.fills, strokes: node.strokes, effects: node.effects, opacity: node.opacity, clips: node.clipsContent,
    characters: node.characters, font: node.fontName, fontSize: node.fontSize, resize: node.textAutoResize, ranges: node.rangeStyles,
    padding: [sourcePadding?.top ?? node.paddingTop ?? padding?.top, sourcePadding?.right ?? node.paddingRight ?? padding?.right,
      sourcePadding?.bottom ?? node.paddingBottom ?? padding?.bottom, sourcePadding?.left ?? node.paddingLeft ?? padding?.left],
    children: node.children.map(child => unaffectedPaints(child, parsedFrames)) };
}
test('Height changes preserve width/names/wrappers/Rich Text/SVG/Gradient across Landing, Dashboard, Form, Fixed, Grid and Mobile', { skip: !baselineSource }, async () => {
  for (const file of ['layer-naming.ts', 'rich-text.ts', 'inline-layout.ts', 'sizing.ts', 'grid.ts', 'svg.ts', 'gradients.ts', 'backgrounds.ts', 'form-controls.ts', 'optimizer.ts'])
    assert.equal(await readFile(`src/${file}`, 'utf8'), await readFile(resolve(baselineSource, file), 'utf8'), `${file} unchanged`);
  const results = [];
  for (const file of ['examples/mvp.html', 'test/dashboard-rendering-regression.html', 'test/form-controls-regression.html', 'test/fixed-position-regression.html',
    'test/phase2-test.html', 'test/rendering-regression.html', 'test/gradient-regression.html', 'test/inline-accessibility-regression.html', 'test/layer-naming-regression.html', 'test/rich-text-regression.html']) {
    const html = await readFile(file, 'utf8'), oldDoc = await parse(html, {}, baselineParser), doc = await parse(html);
    assert.deepEqual(withoutHeight(doc), withoutHeight(oldDoc), `${file}: width/structure/names/position/style metadata changed`);
    const before = await convert(oldDoc, {}, baselineConverter), after = await convert(doc);
    assert.deepEqual(unaffectedPaints(after.frame, new Map(nodes(doc.root).filter(node => node.type === 'FRAME').map(node => [node.source?.selector, node]))),
      unaffectedPaints(before.frame, new Map(nodes(oldDoc.root).filter(node => node.type === 'FRAME').map(node => [node.source?.selector, node]))), `${file}: width/text/paints/wrappers/names changed`);
    assert.deepEqual(after.svgImports, before.svgImports); assert.deepEqual(after.images, before.images);
    results.push({ file, nodes: flatten(after.frame).length, widthsEqual: true, namesEqual: true, structureEqual: true, richTextEqual: true, assetsEqual: true });
  }
  await writeFile('test-results/height-regression.json', JSON.stringify({ baseline: '4200294', results }, null, 2));
});

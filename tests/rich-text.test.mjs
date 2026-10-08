import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createFigmaMock, flatten } from './figma-mock.mjs';

let browser, server, url, parser, converter, baselineParser, baselineConverter;
const baselineSource = process.env.RICHTEXT_BASELINE_SRC;
const bundle = async entry => (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'Parser', target: 'es2020' })).outputFiles[0].text;
before(async () => {
  await mkdir('test-results', { recursive: true });
  parser = await bundle('src/parser.ts');
  await build({ entryPoints: ['src/converter.ts'], bundle: true, outfile: 'test-results/rich-text-converter.mjs', format: 'esm', platform: 'node' });
  converter = await import('../test-results/rich-text-converter.mjs');
  if (baselineSource) {
    baselineParser = await bundle(resolve(baselineSource, 'parser.ts'));
    await build({ entryPoints: [resolve(baselineSource, 'converter.ts')], bundle: true, outfile: 'test-results/rich-text-baseline-converter.mjs', format: 'esm', platform: 'node' });
    baselineConverter = await import('../test-results/rich-text-baseline-converter.mjs');
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
      { html, options: { viewport: 375, viewportHeight: 812, autoLayout: true, styles: true, optimizeWrappers: false, ...options } }));
  } finally { await page.close(); }
}
async function convert(doc, options = {}, engine = converter) {
  const mock = createFigmaMock(options); globalThis.figma = mock.figma;
  return { ...await engine.convertDocument(doc), ...mock };
}
const nodes = node => [node, ...node.children.flatMap(nodes)];
const parsed = (doc, name) => nodes(doc.root).find(node => node.name === name);
const find = (frame, name) => flatten(frame).find(node => node.originalName === name || node.name === name);
const fonts = ['Regular', 'Medium', 'SemiBold', 'Bold', 'Italic', 'Bold Italic'].map(style => ({ family: 'Noto Sans KR', style }));
const documentFor = content => `<style>body{margin:0;font:12.5px/1.4 'Noto Sans KR',sans-serif;color:#333D4B}p{margin:0;width:152px}main{display:flex;flex-direction:column;gap:8px}</style><main>${content}</main>`;
const fixture = () => readFile('test/rich-text-regression.html', 'utf8');

// The mock checks API constraints, not Figma text metrics. Wrapping is independently checked in Chromium below.
test('Six mobile question cards retain their wrappers and native SVG with one Fill/Hug continuous Rich Text sentence', async () => {
  const doc = await parse(await fixture()), result = await convert(doc, { fonts });
  const labels = ['양도', '취득', '상속', '증여', '보유', '종부세'];
  for (const [index, label] of labels.entries()) {
    const card = parsed(doc, `card-${index + 1}`), source = parsed(doc, `question-${index + 1}`), target = find(result.frame, source.name);
    assert.equal(card.size.width, 152); assert.equal(card.children[0], source, 'padding/position/clipping wrapper retained');
    assert.equal(card.layout.direction, 'VERTICAL'); assert.equal(card.size.heightMode, 'HUG', 'clipped card grows with wrapped text');
    assert.deepEqual(source.children.map(node => node.type), ['SVG', 'TEXT']);
    const [icon, text] = source.children;
    assert.ok(text.text.startsWith(`${label} `)); assert.equal(text.ranges.length, 1);
    assert.deepEqual([text.ranges[0].start, text.ranges[0].end, text.ranges[0].style.fontWeight], [0, label.length, 600]);
    assert.equal(source.layout.direction, 'HORIZONTAL'); assert.equal(source.layout.align, 'MIN');
    assert.equal(source.size.heightMode, 'HUG'); assert.equal(text.size.widthMode, 'FILL'); assert.equal(text.size.heightMode, 'HUG');
    assert.equal(icon.size.width, 11); assert.equal(icon.size.height, 11); assert.equal(icon.size.widthMode, 'FIXED');
    assert.ok(source.layout.gap >= 5);
    const available = source.size.width - source.layout.padding.left - source.layout.padding.right - source.style.borderWidths.left - source.style.borderWidths.right;
    assert.ok(Math.abs(text.size.width + icon.size.width + source.layout.gap - available) < .001);
    assert.ok(text.rect.x >= icon.rect.x + icon.size.width + 5);
    const [figmaIcon, figmaText] = target.children;
    assert.equal(figmaIcon.getPluginData('html-type'), 'svg'); assert.equal(figmaIcon.children[0].type, 'VECTOR');
    assert.equal(figmaIcon.layoutSizingHorizontal, 'FIXED'); assert.equal(figmaText.layoutSizingHorizontal, 'FILL');
    assert.equal(figmaText.layoutSizingVertical, 'HUG'); assert.equal(figmaText.textAutoResize, 'HEIGHT');
    assert.equal(figmaText.characters, text.text); assert.equal(figmaText.getRangeFontName(0, label.length).style, 'SemiBold');
    assert.equal(figmaText.getRangeFontName(label.length + 1, text.text.length).style, 'Regular');
    assert.equal(figmaText.width, text.size.width); assert.equal(find(result.frame, card.name).clipsContent, true);
  }
  assert.equal(result.svgImports.length, 6);
  assert.ok(!result.report.warnings.some(warning => ['NODE_FAILED', 'TEXT_RANGE_STYLE', 'SVG_IMPORT'].includes(warning.code)));
  await writeFile('test-results/rich-text-intermediate.json', JSON.stringify(doc, null, 2));
});

test('Plain Bold/Regular paragraphs share one sentence without deleting existing paragraph Frames', async () => {
  const doc = await parse(await fixture()), { frame } = await convert(doc, { fonts });
  for (const [name, sentence, start, end] of [
    ['acquisition', '취득 분양 아파트 취득세는 언제 내요?', 0, 2],
    ['property-tax', '올해 종부세 대상인지 궁금해요', 3, 9]
  ]) {
    const parent = parsed(doc, name), text = parent.children[0], target = find(frame, name);
    assert.equal(parent.type, 'FRAME'); assert.equal(target.type, 'FRAME'); assert.equal(parent.children.length, 1);
    assert.equal(text.text, sentence); assert.deepEqual([text.ranges[0].start, text.ranges[0].end], [start, end]);
    assert.equal(target.children[0].getRangeFontName(start, end).style, 'Bold');
    assert.equal(target.children[0].textAutoResize, 'HEIGHT'); assert.equal(target.children[0].width, 152);
  }
});

test('Character ranges preserve nested font, size, color, spacing, line height and propagated decorations with UTF-16 offsets', async () => {
  const html = documentFor('<p id="styles">😀 <b>굵게</b> <em>기울임</em> <u>밑줄 <strong>중첩</strong></u> <small>작게</small> <span style="color:rgba(20,40,60,.5);font-size:15px;letter-spacing:1.5px;line-height:23px;text-decoration:line-through">색상</span> <i style="font-family:Inter">Latin</i></p>');
  const doc = await parse(html), text = parsed(doc, 'styles').children[0], { frame, report } = await convert(doc, { fonts: [...fonts, { family: 'Inter', style: 'Italic' }] });
  assert.equal(text.text, '😀 굵게 기울임 밑줄 중첩 작게 색상 Latin');
  const target = find(frame, 'styles').children[0];
  const span = word => [text.text.indexOf(word), text.text.indexOf(word) + word.length];
  assert.deepEqual(span('굵게'), [3, 5]); assert.equal(target.getRangeFontName(...span('굵게')).style, 'Bold');
  assert.equal(target.getRangeFontName(...span('기울임')).style, 'Italic');
  assert.equal(target.getRangeTextDecoration(...span('중첩')), 'UNDERLINE');
  assert.equal(target.getRangeFontName(...span('중첩')).style, 'Bold');
  assert.equal(target.getRangeFontSize(...span('작게')), text.ranges.find(range => text.text.slice(range.start, range.end) === '작게').style.fontSize);
  assert.equal(target.getRangeFontSize(...span('색상')), 15);
  assert.deepEqual(target.getRangeLetterSpacing(...span('색상')), { unit: 'PIXELS', value: 1.5 });
  assert.deepEqual(target.getRangeLineHeight(...span('색상')), { unit: 'PIXELS', value: 23 });
  assert.equal(target.getRangeTextDecoration(...span('색상')), 'STRIKETHROUGH');
  assert.equal(target.getRangeFills(...span('색상'))[0].opacity, .5);
  assert.deepEqual(target.getRangeFontName(...span('Latin')), { family: 'Inter', style: 'Italic' });
  assert.ok(!report.warnings.some(warning => warning.code === 'TEXT_RANGE_STYLE'));
  assert.ok(target.rangeStyles[0].loadedFonts.includes('Inter|Italic'), 'all range fonts loaded before the first Range API');
});

test('Whitespace collapses across childNodes while authored spaces, NBSP, line breaks and preformatted content survive', async () => {
  const html = documentFor('<p id="spaces">  <b>양도</b> \n 집 <strong> 한</strong> 채면&nbsp;<i>가능</i>해요  </p><p id="break">첫 <strong>문장</strong><br>다음 줄</p><p id="pre" style="white-space:pre-wrap">  <b>양도</b>  집\n 두 채  </p>');
  const doc = await parse(html);
  assert.equal(parsed(doc, 'spaces').children[0].text, '양도 집 한 채면\u00a0가능해요');
  assert.equal(parsed(doc, 'break').children[0].text, '첫 문장\n다음 줄');
  assert.equal(parsed(doc, 'pre').children[0].text, '  양도  집\n 두 채  ');
  const { frame, report } = await convert(doc, { fonts });
  assert.equal(find(frame, 'spaces').children.length, 1); assert.equal(find(frame, 'break').children[0].characters, '첫 문장\n다음 줄');
  assert.ok(!report.warnings.some(warning => warning.code === 'NODE_FAILED'));
});

test('Badge and other inline boxes keep their frames, descendants and independent styles instead of merging into ranges', async () => {
  const boxes = ['background:#E6F4F1', 'border:1px solid red', 'border-radius:4px', 'padding:2px 6px', 'width:100px', 'height:30px',
    'display:inline-flex', 'display:flex', 'position:absolute;left:0;top:30px', 'position:fixed;left:0;top:50px',
    'box-shadow:0 2px 3px #ccc', 'transform:translateX(1px)', 'opacity:.5'];
  const doc = await parse(documentFor(boxes.map((style, index) => `<p id="box-row-${index}">앞 <strong>강조</strong> <span id="box-${index}" style="${style}">박스 <b>내용</b></span> 뒤</p>`).join(''))), { frame } = await convert(doc, { fonts });
  for (let index = 0; index < boxes.length; index++) {
    const source = parsed(doc, `box-${index}`), target = find(frame, source.name);
    assert.equal(source.type, 'FRAME', boxes[index]); assert.equal(target.type, 'FRAME', boxes[index]);
    assert.equal(flatten(target).filter(node => node.type === 'TEXT').map(node => node.characters).join(' '), '박스 내용', boxes[index]);
    assert.ok(target.parent); assert.ok(!target.removed);
  }
  const mobile = await convert(await parse(await fixture()), { fonts }), badge = find(mobile.frame, 'retained-badge');
  assert.equal(badge.type, 'FRAME'); assert.equal(badge.children[0].characters, '대화에서 · 방금');
  assert.equal(badge.paddingLeft, 6); assert.equal(badge.topLeftRadius, 999); assert.equal(badge.fills[0].type, 'SOLID');
  assert.equal(find(mobile.frame, 'question-badge-row').children[0].characters, '그 집에 실제로 산 기간이 있나요?');
});

test('Unavailable weights use nearest loaded style and range API failures retain content and the rest of the document', async () => {
  const doc = await parse(documentFor('<p id="fallback"><b style="font-weight:600">양도</b> 세금 질문 <em>안내</em></p><p id="next">다음 문장</p>'));
  const result = await convert(doc, { fonts: ['Regular', 'Medium', 'Bold'].map(style => ({ family: 'Noto Sans KR', style })) });
  const text = find(result.frame, 'fallback').children[0];
  assert.equal(text.getRangeFontName(0, 2).style, 'Medium');
  assert.ok(result.report.warnings.some(warning => warning.code === 'FONT_STYLE_REPLACED'));
  assert.equal(text.characters, '양도 세금 질문 안내'); assert.ok(find(result.frame, 'next'));
  const failed = await convert(doc, { fonts, failRangeAPI: 'fontName' });
  assert.equal(find(failed.frame, 'fallback').children[0].characters, text.characters);
  assert.ok(failed.report.warnings.some(warning => warning.code === 'TEXT_RANGE_STYLE'));
  assert.ok(find(failed.frame, 'next')); assert.ok(!failed.report.warnings.some(warning => warning.code === 'NODE_FAILED'));
  const unavailable = await convert(doc, { fonts: [...fonts, { family: 'Pretendard', style: 'Regular' }], failFonts: ['Noto Sans KR'] });
  assert.equal(find(unavailable.frame, 'fallback').children[0].getRangeFontName(0, 2).family, 'Pretendard');
  assert.ok(unavailable.report.warnings.some(warning => warning.code === 'FONT_LOAD_FAILED'));
});

test('Auto Layout/styles off and unbounded single-line Rich Text preserve content and explicit wrapping constraints', async () => {
  for (const options of [{ autoLayout: false }, { styles: false }, { autoLayout: false, styles: false }]) {
    const doc = await parse(await fixture(), options), result = await convert(doc, { fonts, rejectStandaloneTextSizing: true });
    const row = find(result.frame, 'question-1'), text = row.children[1];
    assert.equal(text.characters, '양도 집 한 채면 팔아도 세금이 없나요?'); assert.equal(text.textAutoResize, 'HEIGHT');
    if (options.autoLayout === false) { assert.equal(row.layoutMode, 'NONE'); assert.equal(text.width, parsed(doc, 'question-1').children[1].size.width); assert.ok(text.x >= row.children[0].x + 16); }
    if (options.styles === false) { assert.equal(text.rangeStyles, undefined); assert.equal(text.fontSize, 16); }
    assert.ok(!result.report.warnings.some(warning => ['NODE_FAILED', 'TEXT_RANGE_STYLE'].includes(warning.code)));
  }
  const doc = await parse(documentFor('<span id="unbounded">Hello <b>world</b></span>')), { frame } = await convert(doc, { fonts });
  const text = parsed(doc, 'unbounded').children[0]; assert.equal(text.size.widthMode, 'HUG');
  assert.equal(find(frame, 'unbounded').children[0].textAutoResize, 'WIDTH_AND_HEIGHT');
});

test('Merged mobile text and applied widths wrap in one browser column with no text/Icon overlap', async () => {
  const doc = await parse(await fixture()), { frame } = await convert(doc, { fonts });
  const rows = Array.from({ length: 6 }, (_, index) => {
    const parsedRow = parsed(doc, `question-${index + 1}`), [icon, text] = find(frame, parsedRow.name).children;
    return { width: parsedRow.size.width, gap: parsedRow.layout.gap, icon: { width: icon.width, height: icon.height }, text: { width: text.width, characters: text.characters, style: parsedRow.children[1].style, ranges: parsedRow.children[1].ranges } };
  });
  const page = await browser.newPage();
  try {
    await page.goto(url);
    const measurements = await page.evaluate(rows => {
      const results = [];
      for (const row of rows) {
        const parent = document.createElement('div'); Object.assign(parent.style, { display: 'flex', alignItems: 'flex-start', width: `${row.width}px`, gap: `${row.gap}px`, marginBottom: '8px' });
        const icon = document.createElement('div'); Object.assign(icon.style, { flex: 'none', width: `${row.icon.width}px`, height: `${row.icon.height}px` });
        const text = document.createElement('div'); Object.assign(text.style, { flex: '1', minWidth: '0', width: `${row.text.width}px`, fontFamily: row.text.style.fontFamily, fontSize: `${row.text.style.fontSize}px`, lineHeight: `${row.text.style.lineHeight}px` });
        let cursor = 0;
        for (const range of row.text.ranges) {
          text.append(document.createTextNode(row.text.characters.slice(cursor, range.start)));
          const span = document.createElement('span'); span.textContent = row.text.characters.slice(range.start, range.end); span.style.fontWeight = String(range.style.fontWeight); text.append(span); cursor = range.end;
        }
        text.append(document.createTextNode(row.text.characters.slice(cursor))); parent.append(icon, text); document.body.append(parent);
        const p = parent.getBoundingClientRect(), i = icon.getBoundingClientRect(), t = text.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(text);
        results.push({ characters: text.textContent, lines: [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top })), textLeft: t.left, textRight: t.right, iconRight: i.right, parentRight: p.right, height: t.height, lineHeight: row.text.style.lineHeight });
      }
      return results;
    }, rows);
    for (const [index, measure] of measurements.entries()) {
      assert.equal(measure.characters, rows[index].text.characters); assert.ok(measure.textLeft >= measure.iconRight + 5);
      assert.ok(measure.textRight <= measure.parentRight + .01); assert.ok(measure.height >= measure.lineHeight * 2);
      assert.ok(new Set(measure.lines.map(rect => rect.top)).size > 1);
      assert.ok(measure.lines.every(rect => rect.left >= measure.textLeft - .1 && rect.right <= measure.textRight + .5));
    }
    await page.screenshot({ path: 'test-results/rich-text-browser-projection.png', fullPage: true });
  } finally { await page.close(); }
});

test('Message boundary rejects malformed UTF-16 ranges before Figma nodes are allocated', async () => {
  const original = await parse(documentFor('<p id="validate">앞 <strong>강조</strong> 뒤</p>'));
  for (const mutate of [text => { text.ranges[0].end = text.text.length + 1; }, text => { text.ranges[0].start = -1; },
    text => { text.ranges[0].style.fontSize = NaN; }, text => { text.ranges.push({ ...text.ranges[0] }); }]) {
    const doc = structuredClone(original); mutate(parsed(doc, 'validate').children[0]);
    const mock = createFigmaMock(); globalThis.figma = mock.figma;
    await assert.rejects(() => converter.convertDocument(doc), /Rich Text Range/); assert.equal(mock.figma.currentPage.children.length, 0);
  }
});

function snapshot(node) {
  return { type: node.type, name: node.name, x: node.x, y: node.y, width: node.width, height: node.height, layout: node.layoutMode, positioning: node.layoutPositioning,
    horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical, padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft], gap: node.itemSpacing,
    fills: node.fills, strokes: node.strokes, effects: node.effects, opacity: node.opacity, clips: node.clipsContent, constraints: node.constraints, characters: node.characters, font: node.fontName,
    autoResize: node.textAutoResize, size: node.fontSize, lineHeight: node.lineHeight, letterSpacing: node.letterSpacing, fixedChildren: node.numberOfFixedChildren,
    metadata: ['html-source', 'html-type', 'html-grid', 'html-absolute', 'html-position', 'html-background-grid-line'].map(key => node.getPluginData(key)), children: node.children.map(snapshot) };
}
test('Pre-Rich-Text engine retains identical Dashboard/Form/Landing/Fixed/Grid rendering and Layer Naming module', { skip: !baselineSource }, async () => {
  assert.equal(await readFile('src/layer-naming.ts', 'utf8'), await readFile(resolve(baselineSource, 'layer-naming.ts'), 'utf8'), 'completed Layer Naming code unchanged');
  const selections = [
    ['test/dashboard-rendering-regression.html', ['donut', 'line-chart', 'chart-wrap', 'summary', 'error', 'icon']],
    ['test/form-controls-regression.html', ['family-name', 'name-placeholder', 'message', 'selected-city', 'checkbox', 'radio', 'summary-table']],
    ['test/fixed-position-regression.html', ['fixed-toolbar', 'fixed-top', 'fixed-label']],
    ['test/phase2-test.html', ['grid-three', 'grid-mixed', 'inline-icon', 'position-demo', 'styled-card', 'clipped', 'flex-demo']],
    ['examples/mvp.html', ['hero', 'header', 'card-list']]
  ];
  const results = [];
  for (const [file, names] of selections) {
    const html = await readFile(file, 'utf8'), oldDoc = await parse(html, {}, baselineParser), doc = await parse(html);
    assert.deepEqual(doc, oldDoc, `${file}: entire unaffected parsed document including Layer Naming`);
    const oldResult = await convert(oldDoc, {}, baselineConverter), result = await convert(doc);
    assert.deepEqual(snapshot(result.frame), snapshot(oldResult.frame), `${file}: entire unaffected Figma tree`);
    assert.deepEqual({ ...result.report, durationMs: 0 }, { ...oldResult.report, durationMs: 0 }, `${file}: conversion report`);
    assert.deepEqual(result.svgImports, oldResult.svgImports, `${file}: native SVG bytes`); assert.deepEqual(result.images, oldResult.images, `${file}: image bytes`);
    let checked = 0;
    for (const name of names) {
      const oldSource = parsed(oldDoc, name), source = parsed(doc, name);
      assert.ok(oldSource, `${file}: ${name} regression selection must exist`);
      assert.deepEqual(source, oldSource, `${file}: ${name} IR`);
      assert.deepEqual(snapshot(find(result.frame, name)), snapshot(find(oldResult.frame, name)), `${file}: ${name} Figma output`); checked++;
    }
    assert.ok(checked > 0, `${file}: regression selections must exist`); results.push({ file, checked, nodes: flatten(result.frame).length, entireTreeEqual: true, namesEqual: true, svgBytesEqual: true, imageBytesEqual: true });
  }
  await writeFile('test-results/rich-text-regression.json', JSON.stringify({ baseline: '007c1ae', results }, null, 2));
});

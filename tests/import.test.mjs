import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createFigmaMock, flatten } from './figma-mock.mjs';

let browser, server, base, converter, parserBundle, utilities, gradients;
const sample = await readFile('examples/mvp.html', 'utf8');
before(async () => {
  await mkdir('test-results', { recursive: true });
  parserBundle = (await build({ entryPoints: ['src/parser.ts'], bundle: true, write: false, format: 'iife', globalName: 'Parser', target: 'es2020' })).outputFiles[0].text;
  await build({ entryPoints: ['src/converter.ts'], bundle: true, outfile: 'test-results/converter.mjs', format: 'esm', platform: 'node' });
  converter = await import('../test-results/converter.mjs');
  await build({ entryPoints: ['src/utils.ts'], bundle: true, outfile: 'test-results/utils.mjs', format: 'esm', platform: 'node' });
  utilities = await import('../test-results/utils.mjs');
  await build({ entryPoints: ['src/gradients.ts'], bundle: true, outfile: 'test-results/gradients.mjs', format: 'esm', platform: 'node' });
  gradients = await import('../test-results/gradients.mjs');
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

test('Accessibility clipping patterns skip hidden labels without dropping small SVG, dots, dividers or progress bars', async () => {
  const doc = await parse(await readFile('test/inline-accessibility-regression.html', 'utf8'));
  const { frame, report } = await convert(doc);
  assert.ok(!find(frame, 'hidden-label'));
  assert.ok(!find(frame, 'hidden-inset'));
  for (const name of ['visible-dot', 'small-svg', 'divider', 'progress', 'tiny-dot', 'tiny-visible-clip', 'visible-text']) assert.ok(find(frame, name), name);
  assert.equal(find(frame, 'small-svg').getPluginData('html-type'), 'svg');
  assert.equal(find(frame, 'divider').width, 1);
  assert.equal(find(frame, 'progress').height, 1);
  assert.ok(!flatten(frame).some(node => /Hidden Label|Screen reader only|Secret inline label/.test(node.characters || '')));
  assert.ok(flatten(frame).some(node => node.characters === 'Visible label'));
  assert.ok(!report.warnings.some(warning => warning.code === 'ACCESSIBILITY_HIDDEN'));
});

test('Mixed question and Badge remain separate editable children with Horizontal Hug layout and original styling', async () => {
  const doc = await parse(await readFile('test/inline-accessibility-regression.html', 'utf8'));
  const { frame, report } = await convert(doc);
  const question = find(frame, 'question'), badge = find(frame, 'question-badge');
  assert.equal(question.type, 'FRAME'); assert.equal(question.layoutMode, 'HORIZONTAL');
  assert.deepEqual(question.children.map(child => child.type), ['TEXT', 'FRAME']);
  assert.equal(question.children[0].characters, '그 집에 실제로 산 기간이 있나요?');
  assert.equal(badge.layoutMode, 'HORIZONTAL'); assert.equal(badge.layoutSizingHorizontal, 'HUG');
  assert.equal(badge.layoutSizingVertical, 'HUG');
  assert.deepEqual([badge.paddingTop, badge.paddingRight, badge.paddingBottom, badge.paddingLeft], [2, 7, 2, 7]);
  assert.equal(badge.topLeftRadius, 5);
  assert.deepEqual(badge.fills[0].color, { r: 230 / 255, g: 244 / 255, b: 241 / 255 });
  assert.equal(badge.children[0].characters, '대화에서 · 방금');
  assert.equal(badge.children[0].fontSize, 11.5);
  assert.deepEqual(badge.children[0].fills[0].color, { r: 11 / 255, g: 122 / 255, b: 110 / 255 });
  assert.ok(question.itemSpacing >= 8 && question.itemSpacing < 16);
  assert.equal(find(frame, 'question-badge / margin'), undefined, 'browser spacing must not be added twice');
  assert.ok(!report.warnings.some(warning => warning.code === 'NODE_FAILED'));
});

test('Accessibility skipping is based on computed clipping, logs only in Debug and keeps focus-revealed labels', async () => {
  const debug = await parse(await readFile('test/inline-accessibility-regression.html', 'utf8'), { debug: true });
  assert.ok(debug.warnings.some(warning => warning.code === 'ACCESSIBILITY_HIDDEN' && warning.message.includes('[for="field"]')));
  const page = await browser.newPage();
  try {
    await page.goto(base); await page.addScriptTag({ content: parserBundle });
    const states = await page.evaluate(async () => {
      const rendered = await Parser.renderHTML('<style>body{margin:0}label:not(:focus){position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}label:focus{position:static;width:auto;height:auto;overflow:visible;clip-path:none}</style><main><label id="focus-label" tabindex="0">Focus reveals label</label><span id="modern-hidden" style="position:absolute;width:1px;height:1px;clip-path:inset(50%)">Hidden without overflow</span><span id="legacy-hidden" style="position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);white-space:nowrap;margin:-1px;padding:0;border:0">Hidden with compact spacing</span><span id="class-only" class="sr-only">Visible class name</span><svg id="aria-icon" aria-hidden="true" width="12" height="12"><path d="M0 0h12v12H0z"/></svg></main>', 1440, 900, document.getElementById('host'));
      const options = { viewport: 1440, viewportHeight: 900, autoLayout: true, styles: true };
      try {
        const before = await Parser.parseRenderedHTML(rendered, options);
        rendered.document.getElementById('focus-label').focus();
        const after = await Parser.parseRenderedHTML(rendered, options);
        return JSON.stringify({ before, after });
      } finally { rendered.dispose(); }
    });
    const { before, after } = JSON.parse(states);
    assert.ok(!parsedNodes(before.root).some(node => node.name === 'focus-label'));
    for (const name of ['modern-hidden', 'legacy-hidden']) assert.ok(!parsedNodes(before.root).some(node => node.name === name), name);
    assert.ok(parsedNodes(after.root).some(node => node.name === 'focus-label'));
    for (const name of ['class-only', 'aria-icon']) assert.ok(parsedNodes(before.root).some(node => node.name === name), name);
  } finally { await page.close(); }
});

test('Mixed Inline preserves alternating DOM order, typography and small icons without flattening their parent', async () => {
  const { frame } = await convert(await parse(await readFile('test/inline-accessibility-regression.html', 'utf8')));
  const ordered = find(frame, 'ordered');
  assert.deepEqual(ordered.children.map(child => child.type === 'TEXT' ? child.characters : child.name), ['Before', 'ordered-badge', 'After', 'ordered-icon', 'End']);
  assert.equal(find(frame, 'ordered-icon').getPluginData('html-type'), 'svg');
  assert.equal(find(frame, 'ordered-badge').children[0].characters, 'NEW');
  const iconLabel = find(frame, 'icon-label');
  assert.equal(iconLabel.layoutMode, 'HORIZONTAL');
  assert.deepEqual(iconLabel.children.map(child => child.type), ['TEXT', 'FRAME']);
  assert.equal(find(frame, 'inline-icon').width, 12);
  const styled = find(frame, 'styled-font');
  assert.deepEqual(styled.children.map(child => child.characters), ['Normal', 'Bold']);
  assert.equal(styled.children[1].fontName.style, 'Bold');
});

test('Plain Inline text stays one Text while radius and explicit inline box dimensions retain Frames', async () => {
  const { frame } = await convert(await parse(await readFile('test/inline-accessibility-regression.html', 'utf8')));
  assert.equal(find(frame, 'plain').type, 'TEXT'); assert.equal(find(frame, 'plain').characters, 'Hello');
  assert.equal(find(frame, 'plain-children').type, 'TEXT'); assert.equal(find(frame, 'plain-children').characters, 'Hello world');
  assert.equal(find(frame, 'line-breaks').type, 'TEXT'); assert.equal(find(frame, 'line-breaks').characters, 'first\nsecond');
  assert.equal(find(frame, 'radius-only').type, 'FRAME'); assert.equal(find(frame, 'radius-only').topLeftRadius, 5);
  assert.equal(find(frame, 'radius-only').children[0].characters, 'Radius');
  const width = find(frame, 'width-only');
  assert.equal(width.type, 'FRAME'); assert.equal(width.width, 120); assert.equal(width.height, 32);
  assert.equal(width.children[0].characters, 'Fixed box');
});

test('Wrapped Inline and disabled Auto Layout retain browser-relative child positions without dropping styled content', async () => {
  const html = await readFile('test/inline-accessibility-regression.html', 'utf8');
  const { doc, measurements } = await parseWithBrowserRects(html, ['#wrapped']);
  const { frame } = await convert(doc);
  const wrapped = find(frame, 'wrapped'), parsed = parsedNodes(doc.root).find(node => node.name === 'wrapped');
  assert.equal(wrapped.layoutMode, 'NONE');
  const measuredBadge = measurements['#wrapped'].children[0];
  assert.equal(find(wrapped, 'wrapped-badge').x, measuredBadge.x);
  assert.equal(find(wrapped, 'wrapped-badge').y, measuredBadge.y);
  parsed.children.forEach((child, index) => {
    assert.equal(wrapped.children[index].x, child.rect.x - parsed.rect.x);
    assert.equal(wrapped.children[index].y, child.rect.y - parsed.rect.y);
  });
  assert.ok(wrapped.children.some(child => child.type === 'TEXT' && child.textAutoResize === 'HEIGHT'));
  for (const options of [{ autoLayout: false }, { styles: false }]) {
    const result = await convert(await parse(html, options));
    const question = find(result.frame, 'question'), badge = find(result.frame, 'question-badge');
    assert.equal(question.children[0].characters, '그 집에 실제로 산 기간이 있나요?');
    assert.equal(badge.children[0].characters, '대화에서 · 방금');
    assert.ok(!flatten(result.frame).some(node => /Hidden Label|Secret inline label/.test(node.characters || '')));
    if (options.autoLayout === false) assert.equal(question.layoutMode, 'NONE');
    if (options.styles === false) assert.deepEqual(badge.fills, []);
  }
});

test('Requested four-stop top-level Gradient produces a visible linear Paint without losing content', async () => {
  const doc = await parse(await readFile('test/gradient-regression.html', 'utf8'));
  const { frame, report } = await convert(doc);
  assert.equal(frame.fills[0]?.type, 'GRADIENT_LINEAR');
  assert.deepEqual(frame.fills[0].gradientStops.map(stop => stop.position), [0, .4, .8, 1]);
  assert.deepEqual(frame.fills[0].gradientStops.map(stop => stop.color), [
    { r: 1, g: 1, b: 1, a: 1 }, { r: 241 / 255, g: 248 / 255, b: 246 / 255, a: 1 },
    { r: 238 / 255, g: 242 / 255, b: 250 / 255, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }
  ]);
  assert.equal(find(frame, 'swatches').layoutMode, 'VERTICAL');
  for (const row of find(frame, 'swatches').children) {
    assert.deepEqual(row.fills, []);
    for (const cell of row.children) assert.deepEqual(cell.fills, []);
  }
  const label = find(frame, 'gradient-label');
  assert.equal(label.type, 'FRAME'); assert.equal(label.fills[0].type, 'GRADIENT_LINEAR');
  assert.equal(label.children[0].characters, 'Gradient Text Frame');
  assert.deepEqual(label.children[0].fills.map(paint => paint.type), ['SOLID']);
  assert.equal(find(frame, 'gradient-input').children[0].characters, '김');
  assert.equal(find(frame, 'gradient-svg').getPluginData('html-type'), 'svg');
  assert.ok(!report.warnings.some(warning => warning.code === 'NODE_FAILED'));
});

test('Gradient angles map CSS endpoints to the correct Figma stop coordinates, including hex and rgba alpha', async () => {
  const doc = await parse(await readFile('test/gradient-regression.html', 'utf8'));
  const { frame } = await convert(doc);
  const endpoints = [
    ['up', [0.5, 1], [0.5, 0]], ['right', [0, 0.5], [1, 0.5]],
    ['down', [0.5, 0], [0.5, 1]], ['left', [1, 0.5], [0, 0.5]]
  ];
  for (const [name, start, end] of endpoints) {
    const paint = find(frame, name).fills[0];
    assert.equal(paint.type, 'GRADIENT_LINEAR', name);
    const [[a, b, c], [d, e, f]] = paint.gradientTransform;
    const map = ([x, y]) => [a * x + b * y + c, d * x + e * y + f];
    assert.deepEqual(map(start), [0, .5], `${name}: first stop`);
    assert.deepEqual(map(end), [1, .5], `${name}: last stop`);
  }
  assert.equal(find(frame, 'right').fills[0].gradientStops[1].color.a, .5);
  const result = gradients.parseLinearGradient('linear-gradient(90deg, #1234 0%, rgba(10, 20, 30, .25) 50%, rgb(40 50 60 / 75%) 100%)');
  assert.equal(result.warning, undefined);
  assert.deepEqual(result.gradient.stops.map(stop => stop.color.a), [68 / 255, .25, .75]);
  assert.deepEqual(gradients.parseLinearGradient('linear-gradient(#fff, #abc, #000)').gradient.stops.map(stop => stop.position), [0, .5, 1]);
  assert.deepEqual(gradients.parseLinearGradient('linear-gradient(180deg, #fff 60%, #abc 40%, #000)').gradient.stops.map(stop => stop.position), [.6, .6, 1]);
  assert.equal(gradients.parseLinearGradient('linear-gradient(to left, #fff, #000)').gradient.angle, 270);
});

test('Unsupported and malformed Gradients use their first valid color and report a fallback without losing nodes', async () => {
  for (const [css, color] of [
    ['linear-gradient(45deg, rgba(20, 40, 60, .8), #fff)', { r: 20 / 255, g: 40 / 255, b: 60 / 255 }],
    ['linear-gradient(180deg, #abcdef 10px, #ffffff 100%)', { r: 171 / 255, g: 205 / 255, b: 239 / 255 }]
  ]) {
    const doc = await parse(`<style>body{margin:0;background:${css}}main{padding:12px}</style><main><p>Keep content</p></main>`);
    const { frame, report } = await convert(doc);
    assert.equal(frame.fills[0].type, 'SOLID');
    assert.ok(frame.fills[0].opacity > 0);
    assert.deepEqual(frame.fills[0].color, color);
    assert.ok(flatten(frame).some(node => node.characters === 'Keep content'));
    assert.ok(report.warnings.some(warning => warning.code === 'GRADIENT_FALLBACK' && warning.category === 'Unsupported CSS'));
    assert.ok(!report.warnings.some(warning => warning.code === 'NODE_FAILED'));
  }
  for (const css of ['linear-gradient(180deg, bad-color 0%, #abcdef 100%)', 'linear-gradient(180deg, #abcdef 0%)', 'linear-gradient(180deg, #abcdef -10%, #ffffff 100%)']) {
    const result = gradients.parseLinearGradient(css);
    assert.equal(result.gradient, undefined); assert.ok(result.warning);
    assert.deepEqual(result.fallback, { r: 171 / 255, g: 205 / 255, b: 239 / 255, a: 1 });
  }
});

test('Body, html and anonymous wrapper Gradients survive root collapse and wrapper optimization', async () => {
  for (const css of ['body{background:linear-gradient(#fff,#ddeeff)}', 'html{background:linear-gradient(#fff,#ddeeff)}']) {
    const doc = await parse(`<style>body{margin:0}${css}</style><main><p>Root content</p></main>`);
    const { frame } = await convert(doc);
    assert.equal(doc.root.tagName, 'body');
    assert.equal(frame.fills[0].type, 'GRADIENT_LINEAR');
    assert.ok(flatten(frame).some(node => node.characters === 'Root content'));
  }
  const doc = await parse('<style>body{margin:0}p{margin:0}main>div{background:linear-gradient(#fff,#ddeeff)}</style><main><div><p>Keep wrapper</p></div></main>');
  const { frame } = await convert(doc);
  assert.equal(find(frame, 'div').fills[0].type, 'GRADIENT_LINEAR');
});

test('Gradient Paint API rejection falls back to Solid while retaining opacity and editable descendants', async () => {
  const doc = await parse('<style>body{margin:0}main{background:linear-gradient(180deg,rgba(30,60,90,.8),#fff);opacity:.5}</style><main><p>Preserve me</p></main>');
  const { frame, report } = await convert(doc, { failGradientPaint: true });
  assert.equal(frame.fills[0].type, 'SOLID');
  assert.deepEqual(frame.fills[0].color, { r: 30 / 255, g: 60 / 255, b: 90 / 255 });
  assert.equal(frame.fills[0].opacity, .8); assert.equal(frame.opacity, .5);
  assert.ok(flatten(frame).some(node => node.characters === 'Preserve me'));
  assert.ok(report.warnings.some(warning => warning.code === 'GRADIENT_FALLBACK'));
  assert.ok(!report.warnings.some(warning => warning.code === 'NODE_FAILED'));
});

test('Gradients retain solid background, image layer order and separate stop, paint and node opacity', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const html = `<style>body{margin:0}main{background-color:rgba(10,20,30,.6);background-image:linear-gradient(90deg,rgba(240,248,255,.4),#fff),url("${png}");background-size:auto,contain;background-position:center;background-repeat:no-repeat;opacity:.5}p{opacity:.7}</style><main><p>Keep alpha</p></main>`;
  const { frame, report, images } = await convert(await parse(html));
  assert.deepEqual(frame.fills.map(paint => paint.type), ['GRADIENT_LINEAR', 'IMAGE', 'SOLID']);
  assert.equal(frame.fills[0].opacity, 1); assert.equal(frame.fills[0].gradientStops[0].color.a, .4);
  assert.equal(frame.fills[1].scaleMode, 'FIT'); assert.equal(frame.fills[2].opacity, .6);
  assert.equal(frame.opacity, .5); assert.equal(find(frame, 'p').opacity, .7);
  assert.equal(report.image, 1); assert.equal(images.length, 1);
  const disabledImages = await convert(await parse(html, { images: false }));
  assert.deepEqual(disabledImages.frame.fills.map(paint => paint.type), ['GRADIENT_LINEAR', 'SOLID']);
  assert.equal(disabledImages.images.length, 0);
  const disabledStyles = await convert(await parse(html, { styles: false }));
  assert.deepEqual(disabledStyles.frame.fills, []);
  assert.ok(flatten(disabledStyles.frame).some(node => node.characters === 'Keep alpha'));
});

test('Form controls preserve value, placeholder and selected option as editable Frame + Text', async () => {
  const doc = await parse(await readFile('test/form-controls-regression.html', 'utf8'));
  const { frame, report } = await convert(doc);
  const contents = {
    'family-name': '김', 'name-placeholder': '이름을 입력하세요', 'zero-input': '0',
    message: '첫 번째 줄\n두 번째 줄', 'message-placeholder': '메시지를 입력하세요',
    'selected-city': '부산', 'default-city': '대전', 'option-label': '화면에 표시되는 이름', 'labeled-input': '박'
  };
  for (const [name, text] of Object.entries(contents)) {
    const control = find(frame, name);
    assert.equal(control.type, 'FRAME', name);
    assert.deepEqual(control.children.map(child => [child.type, child.characters]), [['TEXT', text]], name);
    assert.equal(control.children[0].getPluginData('html-absolute'), '', name);
    assert.ok(control.children[0].x >= 14, `${name}: border and padding retained`);
    assert.ok(control.children[0].y >= 10, `${name}: inner text stays within padding`);
    assert.equal(control.strokeTopWeight, 2);
    assert.equal(control.topLeftRadius, 6);
  }
  for (const name of ['empty-input', 'empty-textarea', 'empty-select']) assert.equal(find(frame, name).children.length, 0, name);
  const placeholder = find(frame, 'name-placeholder').children[0];
  assert.deepEqual(placeholder.fills[0].color, { r: 119 / 255, g: 136 / 255, b: 153 / 255 });
  assert.equal(placeholder.opacity, .6);
  assert.equal(find(frame, 'family-name').children[0].textAutoResize, 'WIDTH_AND_HEIGHT');
  assert.equal(find(frame, 'message').children[0].textAutoResize, 'HEIGHT');
  assert.ok(!flatten(frame).some(node => node.type === 'TEXT' && ['서울', '제주', '성 입력', '내부 option 텍스트', '선택되지 않음'].includes(node.characters)));
  assert.equal(report.warnings.filter(warning => warning.code === 'NODE_FAILED').length, 0);
});

test('Form content reads live DOM properties instead of initial value attributes and textarea textContent', async () => {
  const page = await browser.newPage();
  let doc;
  try {
    await page.goto(base); await page.addScriptTag({ content: parserBundle });
    doc = JSON.parse(await page.evaluate(async () => {
      const rendered = await Parser.renderHTML('<style>body{margin:0}input,textarea,select{font:16px/24px Inter;width:220px}</style><main><input id="live-input" value="old" placeholder="fallback"><textarea id="live-textarea">old textarea</textarea><select id="live-select"><option>현재 선택</option><option selected>초기 선택</option></select><input id="cleared-input" value="old" placeholder="대체 텍스트"><textarea id="cleared-textarea" placeholder="빈 메모">old content</textarea></main>', 1440, 900, document.getElementById('host'));
      try {
        const dom = rendered.document;
        dom.getElementById('live-input').value = '현재 김';
        dom.getElementById('live-textarea').value = '현재 메모\n두 줄';
        dom.getElementById('live-select').selectedIndex = 0;
        dom.getElementById('cleared-input').value = '';
        dom.getElementById('cleared-textarea').value = '';
        return JSON.stringify(await Parser.parseRenderedHTML(rendered, { viewport: 1440, viewportHeight: 900, autoLayout: true, styles: true }));
      } finally { rendered.dispose(); }
    }));
  } finally { await page.close(); }
  const { frame } = await convert(doc);
  for (const [name, value] of [['live-input', '현재 김'], ['live-textarea', '현재 메모\n두 줄'], ['live-select', '현재 선택'], ['cleared-input', '대체 텍스트'], ['cleared-textarea', '빈 메모']]) assert.deepEqual(find(frame, name).children.map(child => child.characters), [value], name);
});

test('Form content changes retain checkbox, radio, button and neighboring Grid, Flex, Table, Absolute and Image behavior', async () => {
  const html = await readFile('test/form-controls-regression.html', 'utf8');
  for (const options of [{}, { autoLayout: false, styles: false }]) {
    const doc = await parse(html, options);
    const { frame, report } = await convert(doc);
    for (const name of ['checkbox', 'radio', 'input-button']) assert.equal(find(frame, name).children.length, 0, name);
    assert.deepEqual(flatten(find(frame, 'save-button')).filter(node => node.type === 'TEXT').map(node => node.characters), ['저장']);
    assert.deepEqual(flatten(find(frame, 'summary-table')).filter(node => node.type === 'TEXT').map(node => node.characters), ['항목', '상태', '입력 내용', '유지']);
    assert.equal(find(frame, 'form-grid').layoutMode, options.autoLayout === false ? 'NONE' : 'VERTICAL');
    assert.equal(find(frame, 'actions').layoutMode, options.autoLayout === false ? 'NONE' : 'HORIZONTAL');
    assert.equal(find(frame, 'badge').getPluginData('html-absolute'), 'true');
    assert.equal(find(frame, 'neighbor-text').characters, '기존 Layout과 Typography 유지');
    assert.equal(find(frame, 'neighbor-image').fills[0].type, 'IMAGE');
    assert.deepEqual(find(frame, 'family-name').children.map(node => node.characters), ['김']);
    assert.equal(report.total, flatten(frame).length);
    assert.equal(report.warnings.filter(warning => warning.code === 'NODE_FAILED').length, 0);
  }
});

async function parseWithBrowserRects(html, selectors, overrides = {}) {
  const page = await browser.newPage();
  try {
    await page.goto(base); await page.addScriptTag({ content: parserBundle });
    return JSON.parse(await page.evaluate(async ({ html, selectors, options }) => {
      const rendered = await Parser.renderHTML(html, options.viewport, options.viewportHeight, document.getElementById('host'));
      try {
        const measurements = Object.fromEntries(selectors.map(selector => {
          const element = rendered.document.querySelector(selector), rect = element.getBoundingClientRect();
          return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, children: [...element.children].map(child => {
            const box = child.getBoundingClientRect(); return { name: child.id || child.classList[0] || child.localName, x: box.x - rect.x, y: box.y - rect.y, width: box.width, height: box.height };
          }) }];
        }));
        const doc = await Parser.parseRenderedHTML(rendered, options);
        return JSON.stringify({ doc, measurements });
      } finally { rendered.dispose(); }
    }, { html, selectors, options: { viewport: 1440, viewportHeight: 900, autoLayout: true, styles: true, ...overrides } }));
  } finally { await page.close(); }
}

test('Fixed bottom toolbar uses the viewport, escaping a long clipped parent while absolute stays parent-relative', async () => {
  const { doc, measurements } = await parseWithBrowserRects(await readFile('test/fixed-position-regression.html', 'utf8'), ['#fixed-toolbar', '#clipped-parent', '#absolute-card', '#toolbar-absolute']);
  const { frame, report } = await convert(doc);
  const toolbar = find(frame, 'fixed-toolbar'), parent = find(frame, 'clipped-parent'), absolute = find(frame, 'absolute-card');
  assert.ok(frame.height > 2400, 'full document remains tall');
  assert.equal(toolbar.parent, frame, 'fixed layer escapes its DOM parent clipping');
  assert.deepEqual({ x: toolbar.x, y: toolbar.y, width: toolbar.width, height: toolbar.height }, { x: 240, y: 824, width: 1200, height: 76 });
  assert.deepEqual(measurements['#fixed-toolbar'].x, toolbar.x);
  assert.deepEqual(measurements['#fixed-toolbar'].y, toolbar.y);
  if (frame.layoutMode !== 'NONE') assert.equal(toolbar.layoutPositioning, 'ABSOLUTE');
  assert.deepEqual(toolbar.constraints, { horizontal: 'MIN', vertical: 'MIN' });
  assert.equal(parent.clipsContent, true);
  assert.equal(absolute.parent, parent);
  assert.equal(absolute.y, measurements['#absolute-card'].y - measurements['#clipped-parent'].y);
  assert.deepEqual(absolute.constraints, { horizontal: 'STRETCH', vertical: 'MAX' });
  const innerAbsolute = find(frame, 'toolbar-absolute');
  assert.equal(innerAbsolute.parent, toolbar);
  assert.equal(innerAbsolute.x, measurements['#toolbar-absolute'].x - toolbar.x);
  assert.equal(innerAbsolute.y, measurements['#toolbar-absolute'].y - toolbar.y);
  assert.deepEqual(innerAbsolute.constraints, { horizontal: 'MAX', vertical: 'MIN' });
  assert.equal(find(frame, 'form-grid').layoutMode, 'VERTICAL');
  for (const [name, value] of [['name-input', '김'], ['selected-city', '부산'], ['memo', '현재 입력된 내용'], ['toolbar-input', '김']]) assert.equal(find(frame, name).children[0].characters, value);
  for (const name of ['checkbox', 'radio', 'toolbar-button', 'toolbar-copy']) assert.ok(find(frame, name), name);
  assert.deepEqual(flatten(find(frame, 'toolbar-copy')).filter(node => node.type === 'TEXT').map(node => node.characters), ['Viewport bottom', '편집 가능한 자식 유지']);
  assert.deepEqual(frame.children.slice(-3).map(node => node.name), ['fixed-top', 'fixed-toolbar', 'fixed-label']);
  assert.equal(frame.numberOfFixedChildren, 3);
  assert.ok(report.warnings.some(warning => warning.code === 'FIXED_ELEMENT'));
  assert.ok(!report.warnings.some(warning => warning.code === 'NODE_FAILED'));
});

test('Fixed viewport anchors ignore document-relative measured rects inside a transformed long form parent', async () => {
  const html = '<style>body{margin:0}main{display:flex;flex-direction:column;padding-top:50px;height:3000px}.form{position:relative;transform:translateZ(0);width:800px;height:1800px}.action{position:fixed;display:flex;left:240px;right:0;bottom:0;height:76px;background:white}.absolute{position:absolute;left:240px;right:0;bottom:0;height:76px}.inner-absolute{position:absolute;right:8px;bottom:4px;width:12px;height:12px}</style><main><section class="form"><div class="action"><input value="김"><span>Save</span><div class="inner-absolute"></div></div><div class="absolute"></div></section></main>';
  const { doc, measurements } = await parseWithBrowserRects(html, ['.action', '.form', '.absolute']);
  assert.ok(measurements['.action'].y > 1500, 'reproduce a DOM rect positioned inside the tall containing block');
  assert.equal(measurements['.action'].width, 560, 'source parent is narrower than the viewport');
  const { frame } = await convert(doc);
  const action = find(frame, 'action'), absolute = find(frame, 'absolute'), parent = find(frame, 'form');
  assert.equal(action.parent, frame);
  assert.deepEqual([action.x, action.y, action.width, action.height], [240, 824, 1200, 76]);
  assert.equal(find(action, 'input').children[0].characters, '김');
  const innerAbsolute = find(action, 'inner-absolute');
  assert.equal(innerAbsolute.parent, action);
  assert.deepEqual([innerAbsolute.x, innerAbsolute.y], [1180, 60]);
  assert.equal(absolute.parent, parent);
  assert.equal(absolute.y, measurements['.absolute'].y - measurements['.form'].y);
});

test('Fixed offsets follow custom viewport dimensions, percentages and Hug font width changes', async () => {
  const html = await readFile('test/fixed-position-regression.html', 'utf8');
  for (const [viewport, viewportHeight] of [[1111, 777], [375, 812], [1440, 500]]) {
    const { doc, measurements } = await parseWithBrowserRects(html, ['#fixed-toolbar', '#fixed-top', '#fixed-label'], { viewport, viewportHeight });
    const { frame } = await convert(doc, { intrinsicWidthScale: 1.25, textSizingShift: { x: 13, y: -7 } });
    const toolbar = find(frame, 'fixed-toolbar'), top = find(frame, 'fixed-top'), label = find(frame, 'fixed-label');
    assert.deepEqual([toolbar.x, toolbar.y, toolbar.width, toolbar.height], [240, viewportHeight - 76, viewport - 240, 76]);
    assert.ok(Math.abs(top.x - measurements['#fixed-top'].x) < .001, 'CSSOM inset serialization keeps browser subpixel position');
    assert.ok(Math.abs(top.y - measurements['#fixed-top'].y) < .001);
    assert.ok(Math.abs(top.x - viewport * .1) < .02);
    assert.ok(Math.abs(top.y - viewportHeight * .05) < .02);
    assert.equal(viewport - label.x - label.width, 20);
    assert.equal(viewportHeight - label.y - label.height, 100);
    assert.equal(label.textAutoResize, 'WIDTH_AND_HEIGHT');
    assert.equal(label.parent, frame);
  }
});

test('Opposing fixed insets retain auto-sized flex boxes instead of Hug sizing; calc and margins preserve browser positions', async () => {
  const html = '<style>body{margin:0}main{display:flex;flex-direction:column;padding-top:70px;height:3000px}.stretch{position:fixed;display:flex;left:30px;right:40px;top:50px;bottom:60px}.margin{position:fixed;left:calc(10% + 5px);top:20px;margin:7px;width:90px;height:25px}.center{position:fixed;left:0;right:0;bottom:10px;width:100px;height:30px;margin:auto}</style><main><div class="stretch"><p>Keep stretching</p></div><div class="margin">Keep margin</div><div class="center">Center</div></main>';
  const { doc, measurements } = await parseWithBrowserRects(html, ['.stretch', '.margin', '.center']);
  const { frame } = await convert(doc);
  const stretch = find(frame, 'stretch');
  assert.equal(frame.layoutMode, 'VERTICAL'); assert.equal(stretch.layoutPositioning, 'ABSOLUTE');
  assert.deepEqual([stretch.x, stretch.y, stretch.width, stretch.height], [30, 50, 1370, 790]);
  assert.equal(stretch.layoutSizingHorizontal, 'FIXED'); assert.equal(stretch.layoutSizingVertical, 'FIXED');
  for (const name of ['stretch', 'margin', 'center']) {
    const target = find(frame, name), measured = measurements[`.${name}`];
    assert.deepEqual([target.x, target.y, target.width, target.height], [measured.x, measured.y, measured.width, measured.height], name);
  }
});

test('Fixed insets resolve against the viewport for percent, calc and font units despite tall containing blocks', async () => {
  for (const containingBlock of ['transform:translateZ(0)', 'filter:blur(0)', 'contain:paint']) {
    const html = `<style>body{margin:0}main{height:3000px}.parent{${containingBlock};width:800px;height:1800px;margin:60px}.percent{position:fixed;left:10%;top:5%;width:90px;height:30px}.calc{position:fixed;right:calc(10% + 5px);bottom:calc(5% + 4px);width:90px;height:30px}.units{position:fixed;left:2em;top:1.5rem;width:90px;height:30px;font-size:20px}.stretch{position:fixed;display:flex;left:30px;right:40px;top:50px;bottom:60px}.constrained{position:fixed;display:flex;left:30px;right:40px;top:50px;bottom:60px;max-width:500px;min-height:850px}</style><main><div class="parent"><div class="percent">Percent</div><div class="calc">Calc</div><div class="units">Font units</div><div class="stretch">Stretch</div><div class="constrained">Min/max</div></div></main>`;
    const { frame, report } = await convert(await parse(html));
    const percent = find(frame, 'percent'), calc = find(frame, 'calc'), units = find(frame, 'units'), stretch = find(frame, 'stretch'), constrained = find(frame, 'constrained');
    assert.deepEqual([percent.x, percent.y], [144, 45], containingBlock);
    assert.deepEqual([calc.x, calc.y], [1201, 821], containingBlock);
    assert.deepEqual([units.x, units.y], [40, 24], containingBlock);
    assert.deepEqual([stretch.x, stretch.y, stretch.width, stretch.height], [30, 50, 1370, 790], containingBlock);
    assert.deepEqual([constrained.width, constrained.height], [500, 850], containingBlock);
    assert.ok(!report.warnings.some(warning => warning.code === 'NODE_FAILED'));
  }
});

test('Fixed bottom anchors are invariant to document height, preserve legacy JSON and expose viewport coordinates in Debug', async () => {
  for (const documentHeight of [1500, 1800, 3600]) {
    const html = `<style>body{margin:0}main{display:flex;flex-direction:column;height:${documentHeight}px}.form{transform:translateZ(0);height:${documentHeight}px}.action{position:fixed;left:240px;right:0;bottom:0;height:76px;background:white}</style><main><div class="form"><div class="action"><input value="김"><textarea>현재 내용</textarea><select><option selected>선택 항목</option></select></div></div></main>`;
    const doc = await parse(html, { debug: true });
    const source = parsedNodes(doc.root).find(node => node.name === 'action');
    assert.deepEqual(source.layout.fixedInsets, { top: null, right: 0, bottom: 0, left: 240 });
    assert.ok(doc.root.size.height >= documentHeight);
    for (const legacy of [false, true]) {
      if (legacy) delete source.layout.fixedInsets;
      const { frame, report } = await convert(doc);
      const action = flatten(frame).find(node => node.getPluginData('html-source') === 'div.action');
      assert.equal(action.parent, frame);
      assert.deepEqual([action.x, action.y, action.width, action.height], [240, 824, 1200, 76]);
      assert.deepEqual(JSON.parse(action.getPluginData('html-fixed-position')), { viewport: { width: 1440, height: 900 }, x: 240, y: 824 });
      assert.ok(report.warnings.some(warning => warning.code === 'FIXED_POSITION' && warning.message === '[fixed] viewport: 1440×900, x: 240, y: 824'));
      assert.deepEqual(flatten(action).filter(node => node.type === 'TEXT').map(node => node.characters), ['김', '현재 내용', '선택 항목']);
    }
    source.layout.fixedInsets = { top: null, right: 0, bottom: NaN, left: 240 };
    await assert.rejects(() => convert(doc), /Fixed Viewport/);
  }
});

test('Fixed subtrees survive options off and a rejected Figma scroll property without losing viewport coordinates', async () => {
  const html = await readFile('test/fixed-position-regression.html', 'utf8');
  for (const options of [{ autoLayout: false }, { styles: false }, {}]) {
    const { frame, report } = await convert(await parse(html, options), { failFixedChildren: true });
    const toolbar = find(frame, 'fixed-toolbar');
    assert.deepEqual([toolbar.x, toolbar.y, toolbar.width, toolbar.height], [240, 824, 1200, 76]);
    assert.equal(toolbar.parent, frame);
    assert.equal(find(toolbar, 'toolbar-input').children[0].characters, '김');
    assert.equal(find(toolbar, 'toolbar-absolute').parent, toolbar);
    assert.ok(report.warnings.some(warning => warning.code === 'FIXED_SCROLL'));
    assert.ok(!report.warnings.some(warning => warning.code === 'NODE_FAILED'));
    if (options.autoLayout === false) assert.equal(toolbar.layoutMode, 'NONE');
    if (options.styles === false) assert.deepEqual(toolbar.fills, []);
  }
});

test('A fixed decorated text frame and nested fixed elements keep their editable descendants in the correct frame', async () => {
  const doc = await parse('<style>body{margin:0}main{height:2600px}.badge{position:fixed;right:12px;bottom:16px;background:red;padding:4px;border-radius:6px}.outer{position:fixed;left:20px;top:30px;width:200px;height:150px}.inner{position:fixed;right:10px;top:40px;width:80px;height:25px}</style><main><span class="badge">NEW</span><div class="outer"><p>Outer text</p><div class="inner"><strong>Inner text</strong></div></div></main>');
  const { frame } = await convert(doc);
  const badge = find(frame, 'badge'), outer = find(frame, 'outer'), inner = find(frame, 'inner');
  for (const node of [badge, outer, inner]) assert.equal(node.parent, frame);
  assert.equal(badge.children[0].characters, 'NEW'); assert.equal(badge.children[0].parent, badge);
  assert.equal(find(outer, 'p').characters, 'Outer text'); assert.equal(find(inner, 'strong').characters, 'Inner text');
  assert.deepEqual([inner.x, inner.y], [1350, 40]);
  assert.ok(frame.children.indexOf(outer) < frame.children.indexOf(inner), 'nested fixed child paints above its parent');
  assert.equal(frame.numberOfFixedChildren, 3);
});

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
    assert.equal(await page.locator('#viewport-height').inputValue(), '812');
    await page.locator('#convert').click();
    await page.waitForFunction(() => !!window.importMessage);
    const message = await page.evaluate(() => window.importMessage);
    assert.equal(message.payload.root.size.width, 375);
    assert.equal(message.payload.options.viewportHeight, 812);
    const { report } = await convert(message.payload);
    await page.evaluate(({ requestId, report }) => window.postMessage({ pluginMessage: { type: 'CONVERSION_COMPLETE', requestId, payload: { success: true, report } } }, '*'), { requestId: message.requestId, report });
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
    await page.evaluate(({ requestId, report }) => window.postMessage({ pluginMessage: { type: 'CONVERSION_COMPLETE', requestId, payload: { success: true, report } } }, '*'), { requestId: message.requestId, report });
    await page.waitForFunction(() => !document.getElementById('viewport-width').disabled);
    await page.locator('#viewport').selectOption('1280');
    assert.equal(await page.locator('#viewport-width').inputValue(), '1280');
    assert.equal(await page.locator('#viewport-height').inputValue(), '800');
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
  assert.equal(sent.at(-1).type, 'CONVERSION_COMPLETE');
  assert.equal(sent.at(-1).requestId, 'main-entry');
  assert.equal(sent.at(-1).payload.success, true);
  assert.equal(sent.at(-1).payload.report.text, 13);
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
  const { frame, report } = await convert(doc, { rejectStandaloneTextSizing: true });
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
  assert.ok(flatten(styled).some(node => node.type === 'TEXT' && node.characters.includes('아래쪽 border만 3px')));
  assert.ok(flatten(find(frame, 'top-badge')).some(node => node.type === 'TEXT' && node.characters === 'z-index 10'));
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

test('Normal Flow block frames retain all element and direct text descendants at measured coordinates', async () => {
  const html = await readFile('test/rendering-regression.html', 'utf8');
  for (const autoLayout of [true, false]) {
    const doc = await parse(html, { autoLayout, optimizeWrappers: false });
    const { frame, report } = await convert(doc, { rejectStandaloneTextSizing: true });
    for (const name of ['individual-border', 'shadow-card', 'minmax-box', 'overflow-inner']) {
      const source = parsedNodes(doc.root).find(node => node.name === name);
      const target = find(frame, name);
      assert.ok(source.children.length > 0, `${name}: DOM parsing retains children`);
      assert.equal(target.layoutMode, 'NONE', `${name}: preserve Normal Flow`);
      assert.deepEqual(flatten(target).filter(node => node.type === 'TEXT').map(node => node.characters), parsedNodes(source).filter(node => node.type === 'TEXT').map(node => node.text), name);
      const checkChildren = (source, target) => {
        assert.equal(target.children.length, source.children.length, source.name);
        source.children.forEach((child, index) => {
          const layer = target.children[index];
          assert.equal(layer.name, child.name);
          assert.equal(layer.x, child.rect.x - source.rect.x, `${child.name}: parent-relative x`);
          assert.equal(layer.y, child.rect.y - source.rect.y, `${child.name}: parent-relative y`);
          assert.equal(layer.width, child.size.width);
          if (child.type === 'FRAME') checkChildren(child, layer);
          else if (layer.type === 'TEXT' && autoLayout && child.size.widthMode === 'FIXED') assert.equal(layer.textAutoResize, 'HEIGHT');
        });
      };
      checkChildren(source, target);
    }
    assert.equal(find(frame, 'overflow-frame').clipsContent, true);
    assert.equal(find(frame, 'individual-border').strokeBottomWeight, 3);
    assert.equal(find(frame, 'shadow-card').effects[0].type, 'DROP_SHADOW');
    assert.equal(report.text, parsedNodes(doc.root).filter(node => node.type === 'TEXT').length);
    assert.equal(report.warnings.filter(warning => warning.code === 'NODE_FAILED').length, 0);
  }
});

test('Final Normal Flow child positions match independent browser measurements after text geometry changes', async () => {
  const cases = [
    ['.individual-border', 'individual-border'], ['.shadow-card .nested-block', 'shadow-card'],
    ['.minmax-box', 'minmax-box'], ['.absolute-card', 'absolute-panel']
  ];
  const { doc, measurements } = await parseWithBrowserRects(await readFile('test/rendering-regression.html', 'utf8'), cases.map(([selector]) => selector));
  const { frame, report } = await convert(doc, { rejectStandaloneTextSizing: true, textSizingShift: { x: 9, y: -11 } });
  for (const [selector, name] of cases) {
    const target = selector.includes('.nested-block') ? find(find(frame, name), 'nested-block') : find(frame, name);
    const expected = measurements[selector].children;
    expected.forEach((child, index) => {
      assert.equal(target.children[index].x, child.x, `${selector} / ${child.name}: final x`);
      assert.equal(target.children[index].y, child.y, `${selector} / ${child.name}: final y`);
      if (index) assert.ok(target.children[index].y >= target.children[index - 1].y + target.children[index - 1].height, `${selector}: vertical children do not overlap`);
    });
  }
  assert.equal(report.warnings.filter(warning => warning.code === 'NODE_FAILED').length, 0);
});

test('Unconstrained single-line inline, direct and decorated text hugs width while wrapping and explicit constraints remain fixed', async () => {
  const doc = await parse(await readFile('test/rendering-regression.html', 'utf8'));
  const { frame, report } = await convert(doc, { rejectStandaloneTextSizing: true });
  for (const name of ['intrinsic-title', 'new-label / text', 'intrinsic-direct / text', 'single-line-block']) {
    const source = parsedNodes(doc.root).find(node => node.name === name), target = find(frame, name);
    assert.equal(source.size.widthMode, 'HUG', name);
    assert.equal(target.textAutoResize, 'WIDTH_AND_HEIGHT', name);
  }
  assert.equal(find(frame, 'intrinsic-title').characters, 'Background Image Test');
  assert.equal(find(frame, 'new-label / text').characters, 'NEW');
  for (const name of ['fixed-label', 'limited-label', 'wrapped-inline']) {
    const source = parsedNodes(doc.root).find(node => node.name === name), target = find(frame, name);
    assert.equal(source.size.widthMode, 'FIXED', name);
    assert.equal(target.width, source.size.width, name);
    assert.equal(target.textAutoResize, 'HEIGHT', name);
  }
  assert.equal(find(frame, 'fixed-label').width, 180);
  assert.equal(report.warnings.filter(warning => warning.code === 'NODE_FAILED').length, 0);
});

test('Auto-width absolute labels retain right and bottom anchors after intrinsic font width changes', async () => {
  const html = '<style>body{margin:0}main{display:flex;flex-direction:column}.parent{position:relative;width:320px;height:120px}.badge{position:absolute;right:16px;bottom:12px}.stretch{position:absolute;left:12px;right:12px;top:10px}</style><main><div class="parent"><span class="badge">NEW</span><span class="stretch">Keep both edges constrained</span></div></main>';
  const doc = await parse(html);
  const { frame, report } = await convert(doc, { rejectStandaloneTextSizing: true, textSizingShift: { x: 9, y: -11 }, intrinsicWidthScale: 1.25 });
  const parent = find(frame, 'parent'), badge = find(frame, 'badge'), stretch = find(frame, 'stretch');
  assert.equal(badge.textAutoResize, 'WIDTH_AND_HEIGHT');
  assert.equal(parent.width - badge.x - badge.width, 16);
  assert.equal(parent.height - badge.y - badge.height, 12);
  assert.deepEqual(badge.constraints, { horizontal: 'MAX', vertical: 'MAX' });
  assert.equal(stretch.textAutoResize, 'HEIGHT');
  assert.equal(stretch.x, 12);
  assert.equal(stretch.width, 296);
  assert.deepEqual(stretch.constraints, { horizontal: 'STRETCH', vertical: 'MIN' });
  assert.equal(report.warnings.filter(warning => warning.code === 'NODE_FAILED').length, 0);
});

test('Absolute frames recursively import both block and flex descendants without inheriting absolute positioning', async () => {
  const doc = await parse(await readFile('test/rendering-regression.html', 'utf8'), { optimizeWrappers: false });
  const { frame, report } = await convert(doc, { rejectStandaloneTextSizing: true });
  const parent = find(frame, 'position-parent');
  const panel = find(frame, 'absolute-panel');
  const sourceParent = parsedNodes(doc.root).find(node => node.name === 'position-parent');
  const sourcePanel = parsedNodes(doc.root).find(node => node.name === 'absolute-panel');
  assert.equal(panel.parent, parent);
  assert.equal(panel.x, sourcePanel.rect.x - sourceParent.rect.x);
  assert.equal(panel.y, sourcePanel.rect.y - sourceParent.rect.y);
  assert.deepEqual(panel.constraints, { horizontal: 'MAX', vertical: 'MIN' });
  assert.deepEqual(flatten(panel).filter(node => node.type === 'TEXT').map(node => node.characters), ['Absolute title', 'Absolute paragraph', 'Absolute span', 'Absolute nested descendant.']);
  assert.ok(panel.children.every(child => child.getPluginData('html-absolute') === ''));
  const flex = find(frame, 'absolute-flex');
  assert.equal(flex.layoutMode, 'VERTICAL');
  assert.deepEqual(flatten(flex).filter(node => node.type === 'TEXT').map(node => node.characters), ['Absolute flex title', 'Block inside absolute flex.']);
  assert.equal(find(frame, 'absolute-caption').characters, 'Absolute text survives.');
  assert.equal(report.absolute, 3);
  assert.equal(report.warnings.filter(warning => warning.code === 'NODE_FAILED').length, 0);
});

test('Optional sizing API failures retain the frame and its already-created descendants', async () => {
  const doc = await parse('<style>body{margin:0}main{padding:12px}.nested-flex{display:flex;flex-direction:column;gap:8px}</style><main><div class="nested-flex"><strong>Retain title</strong><p>Retain paragraph</p></div><span>Retain sibling</span></main>');
  const { frame, report } = await convert(doc, { failSizingNames: ['nested-flex'], rejectStandaloneTextSizing: true });
  const target = find(frame, 'nested-flex');
  assert.ok(target && !target.removed);
  assert.deepEqual(flatten(target).filter(node => node.type === 'TEXT').map(node => node.characters), ['Retain title', 'Retain paragraph']);
  assert.equal(find(frame, 'span').characters, 'Retain sibling');
  assert.equal(report.text, 3);
  assert.ok(report.warnings.some(warning => warning.code === 'SIZING_API' && warning.node === 'nested-flex'));
  assert.equal(report.warnings.filter(warning => warning.code === 'NODE_FAILED').length, 0);
});

test('Multiple backgrounds preserve the first URL at any layer with its matching image settings and children', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const backgrounds = [
    [`linear-gradient(#fff, #000), url("${png}")`, 'auto, contain', 'left top, center', 'repeat, no-repeat', 'FIT'],
    [`url("${png}"), linear-gradient(#fff, #000)`, 'cover, auto', 'center, left top', 'no-repeat, repeat', 'FILL'],
    [`linear-gradient(#fff, #000), radial-gradient(#fff, #000), url("${png}")`, 'contain', 'center', 'no-repeat', 'FIT']
  ];
  for (const [background, size, position, repeat, scaleMode] of backgrounds) {
    const doc = await parse(`<style>body{margin:0}main{display:flex}.bg{width:200px;height:100px;background-image:${background};background-size:${size};background-position:${position};background-repeat:${repeat}}</style><main><div class="bg"><strong>Keep title</strong><p>Keep paragraph</p></div></main>`);
    const parsed = parsedNodes(doc.root).find(node => node.name === 'bg');
    assert.equal(parsed.style.backgroundImage.src, png);
    assert.equal(parsed.style.backgroundImage.fit, scaleMode === 'FIT' ? 'contain' : 'cover');
    assert.equal(parsed.style.backgroundImage.repeat, 'no-repeat');
    const { frame, report, images } = await convert(doc, { rejectStandaloneTextSizing: true });
    const target = find(frame, 'bg');
    const imageFill = target.fills.find(paint => paint.type === 'IMAGE');
    assert.equal(imageFill.scaleMode, scaleMode);
    assert.equal(target.fills.findIndex(paint => paint.type === 'GRADIENT_LINEAR') < target.fills.indexOf(imageFill), background.startsWith('linear-gradient'));
    assert.deepEqual(flatten(target).filter(node => node.type === 'TEXT').map(node => node.characters), ['Keep title', 'Keep paragraph']);
    assert.equal(images.length, 1);
    assert.equal(report.image, 1);
    assert.equal(report.warnings.some(warning => warning.code === 'BACKGROUND_IMAGE'), background.includes('radial-gradient'));
    assert.ok(report.warnings.some(warning => warning.code === 'BACKGROUND_LAYERS'));
    assert.ok(!report.warnings.some(warning => ['BACKGROUND_POSITION', 'BACKGROUND_REPEAT', 'NODE_FAILED'].includes(warning.code)));
  }
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
  assert.equal(parsedNodes(optimized.root).find(node => node.type === 'TEXT' && node.text === 'Hello').size.widthMode, 'HUG', 'removing a wrapper preserves intrinsic text width');
  const { frame } = await convert(optimized);
  assert.ok(flatten(frame).some(node => node.name === 'styled [div.styled.extra.classes]'));
  assert.ok(flatten(frame).some(node => node.type === 'TEXT' && node.characters === 'Hello'));
  assert.equal(flatten(frame).find(node => node.type === 'TEXT' && node.characters === 'Hello').textAutoResize, 'WIDTH_AND_HEIGHT');
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
  assert.equal(pre.textAutoResize, 'WIDTH_AND_HEIGHT');
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
    await page.evaluate(({ requestId, report }) => window.postMessage({ pluginMessage: { type: 'CONVERSION_COMPLETE', requestId, payload: { success: true, report } } }, '*'), { requestId: message.requestId, report });
    await page.waitForFunction(() => document.getElementById('status').dataset.state === 'success');
    assert.equal(await page.locator('#grid-count').textContent(), '2');
    assert.equal(await page.locator('#svg-count').textContent(), '1');
    assert.equal(await page.locator('#absolute-count').textContent(), '2');
    assert.ok((await page.locator('#warnings').textContent()).includes('Grid Fallback:'));
    await page.screenshot({ path: 'test-results/phase2-ui.png', fullPage: true });
  } finally { await page.close(); }
});

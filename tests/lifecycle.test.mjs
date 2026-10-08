import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright';
import { createFigmaMock } from './figma-mock.mjs';

let browser, server, base, mainBundle;
before(async () => {
  const ui = await readFile('dist/ui.html', 'utf8');
  mainBundle = await readFile('dist/code.js', 'utf8');
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.url === '/ui' ? ui : '<!doctype html><iframe src="/ui" width="440" height="1100"></iframe>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const systemChromium = await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || systemChromium, headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });

const htmlFor = name => `<style>body{margin:0;font-family:Inter}p{margin:0}</style><main><p>${name}</p></main>`;
async function openSession({ failFrameOnce = false, corruptReport = false, sourceParent = false, mockOptions = {}, routes = {} } = {}) {
  const page = await browser.newPage();
  for (const [url, response] of Object.entries(routes)) await page.route(url, async route => {
    const { delayMs = 0, ...reply } = response;
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    await route.fulfill(reply);
  });
  await page.goto(base);
  const ui = page.frames().find(frame => frame.url() === `${base}/ui`);
  await ui.locator('#file').waitFor();
  const mock = createFigmaMock(mockOptions), requests = [], replies = [], deliveries = [], heldTerminals = [];
  let holdTerminals = false;
  if (failFrameOnce) {
    const createFrame = mock.figma.createFrame;
    mock.figma.createFrame = () => { if (failFrameOnce) { failFrameOnce = false; throw new Error('Lifecycle root failure'); } return createFrame(); };
  }
  const deliver = delivered => {
    const delivery = ui.evaluate(({ message, sourceParent }) => {
      window.dispatchEvent(new MessageEvent('message', { data: { pluginMessage: message }, source: sourceParent ? parent : null }));
      if (message.type !== 'PROGRESS') window.lastTerminalId = message.requestId;
    }, { message: delivered, sourceParent });
    deliveries.push(delivery);
    delivery.catch(() => {}); // The test awaits deliveries; avoid teardown-time unhandled rejections.
  };
  mock.figma.ui.postMessage = message => {
    replies.push(message);
    const delivered = structuredClone(message);
    if (corruptReport && delivered.type === 'CONVERSION_COMPLETE') delete delivered.payload.outcome.warningTypes;
    if (holdTerminals && ['CONVERSION_COMPLETE', 'CONVERSION_ERROR'].includes(delivered.type)) heldTerminals.push(delivered);
    else deliver(delivered);
  };
  runInNewContext(mainBundle, { figma: mock.figma, __html__: '<html></html>', setTimeout, Uint8Array, console });
  await page.exposeFunction('sendToPluginMain', async message => {
    if (message.type === 'CREATE_FIGMA') requests.push(message);
    await mock.figma.ui.onmessage(message);
  });
  await page.evaluate(() => window.addEventListener('message', event => {
    if (event.source !== document.querySelector('iframe').contentWindow || !event.data?.pluginMessage) return;
    const message = event.data.pluginMessage;
    if (message.type === 'CREATE_FIGMA') {
      window.mainRequestCount = (window.mainRequestCount || 0) + 1;
      window.lastCreateId = message.requestId;
    }
    void window.sendToPluginMain(message);
  }));
  return { page, ui, mock, requests, replies, deliveries,
    holdTerminalReplies() { holdTerminals = true; },
    releaseTerminalReplies() { holdTerminals = false; heldTerminals.splice(0).forEach(deliver); } };
}
async function choose(session, name, content = htmlFor(name), drop = false) {
  if (drop) await session.ui.evaluate(({ name, content }) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([content], name, { type: 'text/html' }));
    document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { name, content });
  else await session.ui.locator('#file').setInputFiles({ name, mimeType: 'text/html', buffer: Buffer.from(content) });
  await session.ui.waitForFunction(() => !document.getElementById('convert').disabled);
}
async function convertOnce(session) {
  const count = session.requests.length;
  await session.ui.locator('#convert').click();
  await session.page.waitForFunction(count => window.mainRequestCount > count, count);
  const requestId = await session.page.evaluate(() => window.lastCreateId);
  await session.ui.waitForFunction(id => window.lastTerminalId === id, requestId);
  await Promise.all(session.deliveries);
  return requestId;
}
async function assertUnlocked(session, expected, ready = true) {
  assert.equal(await session.ui.locator('#status').getAttribute('data-state'), expected);
  for (const id of ['file', 'viewport', 'viewport-width', 'viewport-height', 'autolayout', 'styles', 'images', 'shadows', 'optimize', 'debug', 'asset-files']) assert.ok(await session.ui.locator(`#${id}`).isEnabled(), id);
  assert.equal(await session.ui.locator('#convert').isEnabled(), ready);
  assert.equal(await session.ui.locator('#convert').textContent(), 'Figma로 변환');
  assert.equal(await session.ui.locator('#file').inputValue(), '');
  assert.equal(await session.ui.locator('#dropzone').getAttribute('aria-disabled'), 'false');
  assert.ok(await session.ui.locator('#cancel').isHidden());
}

test('Real iframe UI receives relayed Main completion and converts A, B, C and the same file repeatedly', async () => {
  const session = await openSession();
  try {
    for (const [index, name] of ['A.html', 'B.html', 'C.html', 'A.html', 'A.html'].entries()) {
      await choose(session, name, htmlFor(name), index === 2);
      if (index) assert.equal(await session.ui.locator('#status').getAttribute('data-state'), 'idle');
      await convertOnce(session);
      assert.equal(session.mock.figma.currentPage.children.length, index + 1, 'Canvas creation completed');
      await assertUnlocked(session, 'success');
      assert.equal(await session.ui.locator('#dropzone').evaluate(element => element.classList.contains('drag')), false);
    }
    await convertOnce(session); // Retry directly without selecting or closing the plugin.
    await assertUnlocked(session, 'success');
    assert.equal(session.mock.figma.currentPage.children.length, 6);
    assert.equal(new Set(session.requests.map(message => message.requestId)).size, 6);
  } finally { await session.page.close(); }
});

test('Mobile Rich Text cards repeat through the UI/Main pipeline with identical ranges, widths, names and native SVG', async () => {
  const session = await openSession();
  const content = await readFile('test/rich-text-regression.html', 'utf8');
  const snapshot = node => ({ name: node.name, type: node.type, characters: node.characters || '', width: node.width, height: node.height,
    layout: node.layoutMode, horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical, autoResize: node.textAutoResize,
    ranges: node.rangeStyles ? Array.from(node.rangeStyles, range => ({ start: range.start, end: range.end, property: range.property, value: range.value })) : [],
    children: Array.from(node.children, snapshot) });
  try {
    await session.ui.locator('#viewport').selectOption('375');
    await choose(session, 'mobile-questions.html', content); await convertOnce(session); await assertUnlocked(session, 'success');
    const first = snapshot(session.mock.figma.currentPage.children[0]);
    await choose(session, 'mobile-questions.html', content, true); await convertOnce(session); await assertUnlocked(session, 'success');
    assert.deepEqual(snapshot(session.mock.figma.currentPage.children[1]), first);
    assert.equal(session.mock.svgImports.length, 12);
    const richNodes = session.requests[0].payload.root;
    const visit = node => [node, ...node.children.flatMap(visit)];
    assert.equal(visit(richNodes).filter(node => node.type === 'TEXT' && node.text.startsWith('양도 ')).length, 1);
    assert.ok(session.replies.filter(message => message.type === 'CONVERSION_COMPLETE').every(message => !message.payload.report.warnings.some(warning => ['NODE_FAILED', 'TEXT_RANGE_STYLE'].includes(warning.code))));
  } finally { await session.page.close(); }
});

test('The same accessibility and Mixed Inline HTML repeats without changing its generated layout or UI lifecycle', async () => {
  const session = await openSession();
  const content = await readFile('test/inline-accessibility-regression.html', 'utf8');
  const snapshot = node => ({ type: node.type, name: node.name, characters: node.characters || '', width: node.width, height: node.height, x: node.x, y: node.y,
    layout: node.layoutMode, gap: node.itemSpacing, horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical,
    padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft], radius: node.topLeftRadius,
    fills: node.fills, opacity: node.opacity, children: node.children.map(snapshot) });
  try {
    await choose(session, 'inline-accessibility.html', content); await convertOnce(session); await assertUnlocked(session, 'success');
    const original = snapshot(session.mock.figma.currentPage.children[0]);
    await choose(session, 'inline-accessibility.html', content); await convertOnce(session); await assertUnlocked(session, 'success');
    assert.deepEqual(snapshot(session.mock.figma.currentPage.children[1]), original);
    assert.equal(session.mock.figma.currentPage.children.length, 2);
  } finally { await session.page.close(); }
});

test('Repeated fixed-position conversions use each viewport selected in the actual plugin UI', async () => {
  const session = await openSession();
  const content = await readFile('test/fixed-position-regression.html', 'utf8');
  try {
    for (const [index, [width, height]] of [[1440, 900], [1111, 777], [375, 812]].entries()) {
      await choose(session, 'fixed-position.html', content);
      await session.ui.locator('#viewport').selectOption('custom');
      await session.ui.locator('#viewport-width').fill(String(width));
      await session.ui.locator('#viewport-height').fill(String(height));
      await convertOnce(session); await assertUnlocked(session, 'success');
      assert.equal(session.requests[index].payload.options.viewport, width);
      assert.equal(session.requests[index].payload.options.viewportHeight, height);
      const root = session.mock.figma.currentPage.children[index];
      const toolbar = root.children.find(node => node.originalName === 'fixed-toolbar');
      assert.deepEqual([toolbar.x, toolbar.y, toolbar.width, toolbar.height], [240, height - 76, width - 240, 76]);
      assert.equal(root.numberOfFixedChildren, 3);
    }
  } finally { await session.page.close(); }
});

test('Dashboard HTML converts repeatedly with one Donut arc, all gradient layers and unchanged editable layout', async () => {
  const session = await openSession(), content = await readFile('test/dashboard-rendering-regression.html', 'utf8');
  const snapshot = node => ({ type: node.type, name: node.name, text: node.characters, width: node.width, height: node.height, x: node.x, y: node.y,
    fills: node.fills, layout: node.layoutMode, gap: node.itemSpacing, children: node.children.map(snapshot) });
  try {
    let original;
    for (let index = 0; index < 2; index++) {
      await choose(session, 'dashboard.html', content); await convertOnce(session); await assertUnlocked(session, 'success');
      const root = session.mock.figma.currentPage.children[index];
      const nodes = node => [node, ...node.children.flatMap(nodes)];
      const chart = nodes(root).find(node => node.originalName === 'chart-wrap');
      assert.deepEqual(Array.from(chart.fills, paint => paint.type), ['GRADIENT_LINEAR', 'GRADIENT_LINEAR', 'GRADIENT_LINEAR', 'SOLID']);
      assert.deepEqual(Array.from(chart.children.filter(node => node.getPluginData('html-background-grid-line')), node => node.y), [75, 150, 225]);
      const donut = session.mock.svgImports[index * 3];
      assert.equal((donut.match(/\bM /g) || []).length, 1); assert.match(donut, /stroke-dasharray="none"/);
      const current = snapshot(root);
      if (index === 0) original = current;
      else assert.deepEqual(current, original);
    }
    assert.equal(session.mock.svgImports.length, 6);
    assert.deepEqual(session.mock.svgImports.slice(0, 3), session.mock.svgImports.slice(3));
  } finally { await session.page.close(); }
});

test('Background Debug report exposes computed CSS, four layers and four fills in the running plugin UI', async () => {
  const session = await openSession();
  const background = [25, 50, 75].map(percent => `linear-gradient(to bottom,transparent ${percent - 1}%,#F3F4F6 ${percent}%,transparent ${percent + 1}%)`).join(',');
  try {
    await session.ui.locator('#debug').check();
    await choose(session, 'grid-debug.html', `<style>body{margin:0}.chart{width:600px;height:300px;background:${background},#fff}</style><main><div class="chart"><p>Chart Content</p></div></main>`);
    await convertOnce(session); await assertUnlocked(session, 'success');
    const text = await session.ui.locator('#debug-warnings').textContent();
    for (const message of ['Debug:', 'computed backgroundImage:', 'background layers: 4', 'layer 4: solid #FFFFFF', 'figma fills: 4', 'Grid Line fallback: 3']) assert.ok(text.includes(message), message);
    assert.ok(await session.ui.locator('#debug-warnings li').evaluateAll(items => items.some(item => item.style.whiteSpace === 'pre-line')));
  } finally { await session.page.close(); }
});

test('Viewport presets include height, round-trip custom dimensions and anchor fixed layers independently of the document', async () => {
  const session = await openSession();
  const content = (await readFile('test/fixed-position-regression.html', 'utf8')).replace('#clipped-parent { position: relative;', '#clipped-parent { transform: translateZ(0); position: relative;');
  try {
    for (const [index, [preset, width, height]] of [['1440', 1440, 900], ['1280', 1280, 800], ['768', 768, 1024], ['375', 375, 812]].entries()) {
      await choose(session, 'fixed-presets.html', content);
      await session.ui.locator('#viewport').selectOption(preset);
      assert.equal(await session.ui.locator('#viewport-width').inputValue(), String(width));
      assert.equal(await session.ui.locator('#viewport-height').inputValue(), String(height));
      await session.ui.locator('#viewport-height').fill(String(height + 1));
      assert.equal(await session.ui.locator('#viewport').inputValue(), 'custom');
      await session.ui.locator('#viewport-height').fill(String(height));
      assert.equal(await session.ui.locator('#viewport').inputValue(), preset);
      await convertOnce(session); await assertUnlocked(session, 'success');
      const doc = session.requests[index].payload;
      assert.deepEqual([doc.options.viewport, doc.options.viewportHeight], [width, height]);
      const root = session.mock.figma.currentPage.children[index], toolbar = root.children.find(node => node.originalName === 'fixed-toolbar');
      assert.ok(root.height > 2000);
      assert.deepEqual([toolbar.x, toolbar.y, toolbar.width, toolbar.height], [240, height - 76, width - 240, 76]);
      assert.equal(toolbar.constraints.horizontal, 'MIN'); assert.equal(toolbar.constraints.vertical, 'MIN');
      assert.equal(root.numberOfFixedChildren, 3);
    }
  } finally { await session.page.close(); }
});

test('Main conversion failure releases UI controls and allows the same HTML to succeed next time', async () => {
  const session = await openSession({ failFrameOnce: true });
  try {
    await choose(session, 'retry.html'); await convertOnce(session);
    await assertUnlocked(session, 'error');
    assert.equal(await session.ui.locator('#status').textContent(), 'HTML을 변환하지 못했습니다.');
    assert.ok((await session.ui.locator('#report-error').textContent()).includes('Lifecycle root failure'));
    assert.equal(await session.ui.locator('#report').getAttribute('data-result'), 'ERROR');
    assert.equal(await session.ui.locator('#report-result').textContent(), '결과 Frame을 생성하지 못했습니다.');
    assert.equal(session.mock.figma.currentPage.children.length, 0);
    await choose(session, 'retry.html', htmlFor('retry.html'), true);
    assert.equal(await session.ui.locator('#status').getAttribute('data-state'), 'idle');
    await convertOnce(session); await assertUnlocked(session, 'success');
    assert.equal(session.mock.figma.currentPage.children.length, 1);
    assert.ok(await session.ui.locator('#report-error').isHidden());
    assert.equal(await session.ui.locator('#report-file').textContent(), 'retry.html');
  } finally { await session.page.close(); }
});

test('Report rendering errors cannot leave a successfully created Canvas in the converting state', async () => {
  const session = await openSession({ corruptReport: true, sourceParent: true });
  try {
    await choose(session, 'report.html'); await convertOnce(session);
    assert.equal(session.mock.figma.currentPage.children.length, 1);
    await assertUnlocked(session, 'success');
    assert.ok((await session.ui.locator('#status').textContent()).includes('보고서'));
    await convertOnce(session); await assertUnlocked(session, 'success');
    assert.equal(session.mock.figma.currentPage.children.length, 2);
  } finally { await session.page.close(); }
});

test('Local parse failure releases loading state and ignores stale terminal replies during the next conversion', async () => {
  const session = await openSession();
  try {
    await choose(session, 'hidden.html', '<style>body{display:none}</style><p>hidden</p>');
    await session.ui.locator('#convert').click();
    await session.ui.waitForFunction(() => document.getElementById('status').dataset.state === 'error');
    await assertUnlocked(session, 'error');
    assert.equal(session.requests.length, 0);
    await choose(session, 'good.html'); const oldId = await convertOnce(session);
    // Keep the next request pending until the stale-reply assertions finish; completion speed is not under test.
    session.holdTerminalReplies();
    await choose(session, 'next.html'); await session.ui.locator('#convert').click();
    await session.ui.evaluate(id => window.dispatchEvent(new MessageEvent('message', { data: { pluginMessage: { type: 'CONVERSION_ERROR', requestId: id, payload: { success: false, message: 'stale failure' } } }, source: null })), oldId);
    assert.equal(await session.ui.locator('#status').getAttribute('data-state'), 'converting');
    assert.ok(await session.ui.locator('#file').isDisabled());
    const oldComplete = structuredClone(session.replies.find(message => message.type === 'CONVERSION_COMPLETE' && message.requestId === oldId));
    await session.ui.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: { pluginMessage: message }, source: null })), oldComplete);
    assert.equal(await session.ui.locator('#status').getAttribute('data-state'), 'converting');
    assert.ok(await session.ui.locator('#report').isHidden());
    session.releaseTerminalReplies();
    await session.ui.waitForFunction(id => window.lastTerminalId && window.lastTerminalId !== id, oldId);
    await Promise.all(session.deliveries);
    await assertUnlocked(session, 'success');
  } finally { await session.page.close(); }
});

test('FileReader failures release upload controls and permit a later file selection', async () => {
  const session = await openSession();
  try {
    await session.ui.evaluate(() => {
      window.originalReadAsText = FileReader.prototype.readAsText;
      FileReader.prototype.readAsText = function () { queueMicrotask(() => this.dispatchEvent(new Event('error'))); };
    });
    await session.ui.locator('#file').setInputFiles({ name: 'read-error.html', mimeType: 'text/html', buffer: Buffer.from(htmlFor('read error')) });
    await session.ui.waitForFunction(() => document.getElementById('status').dataset.state === 'error');
    await assertUnlocked(session, 'error', false);
    assert.ok((await session.ui.locator('#status').textContent()).includes('파일 읽기'));
    await session.ui.evaluate(() => { FileReader.prototype.readAsText = window.originalReadAsText; });
    await choose(session, 'read-error.html'); await convertOnce(session); await assertUnlocked(session, 'success');
  } finally { await session.page.close(); }
});

test('Main responds once per request, releases its busy state and retains success when notification fails', async () => {
  const session = await openSession();
  try {
    await choose(session, 'main.html'); await convertOnce(session);
    const payload = session.requests[0].payload;
    const mock = createFigmaMock(), sent = [], notificationErrors = [];
    let releaseFonts;
    const fontsReady = new Promise(resolve => { releaseFonts = resolve; });
    const listFonts = mock.figma.listAvailableFontsAsync;
    mock.figma.listAvailableFontsAsync = async () => { await fontsReady; return listFonts(); };
    mock.figma.ui.postMessage = message => sent.push(message);
    mock.figma.notify = () => { throw new Error('Notification failed'); };
    runInNewContext(mainBundle, { figma: mock.figma, __html__: '', setTimeout, Uint8Array, console: { warn: (...args) => notificationErrors.push(args) } });
    const first = mock.figma.ui.onmessage({ type: 'CREATE_FIGMA', requestId: 'first', payload });
    await mock.figma.ui.onmessage({ type: 'CREATE_FIGMA', requestId: 'busy', payload });
    releaseFonts(); await first;
    await mock.figma.ui.onmessage({ type: 'CREATE_FIGMA', requestId: 'invalid', payload: {} });
    await mock.figma.ui.onmessage({ type: 'CREATE_FIGMA', requestId: 'again', payload });
    const terminals = sent.filter(message => message.type !== 'PROGRESS');
    assert.deepEqual(terminals.map(message => [message.requestId, message.type, message.payload.success]), [
      ['busy', 'CONVERSION_ERROR', false], ['first', 'CONVERSION_COMPLETE', true],
      ['invalid', 'CONVERSION_ERROR', false], ['again', 'CONVERSION_COMPLETE', true]
    ]);
    assert.equal(notificationErrors.filter(args => args[0] === 'Conversion notification failed').length, 2);
    assert.equal(notificationErrors.filter(args => args[0] === 'HTML → Figma conversion failed').length, 1);
    assert.equal(mock.figma.currentPage.children.length, 2);
  } finally { await session.page.close(); }
});

const outcomeFor = session => structuredClone(session.replies.filter(message => message.type === 'CONVERSION_COMPLETE').at(-1).payload.outcome);
test('Report shows SUCCESS with zero warnings, collapses details and replaces filenames on repeated uploads', async () => {
  const session = await openSession();
  try {
    await session.ui.locator('#debug').check();
    for (const name of ['A.html', 'B.html', 'B.html']) {
      await choose(session, name); assert.ok(await session.ui.locator('#report').isHidden());
      await convertOnce(session); await assertUnlocked(session, 'success');
      const outcome = outcomeFor(session);
      assert.equal(outcome.status, 'SUCCESS'); assert.equal(outcome.warningCount, 0);
      assert.deepEqual(outcome.result, { frameCreated: true, frameCount: 1 });
      assert.equal(await session.ui.locator('#report-file').textContent(), name);
      assert.equal(await session.ui.locator('#status').textContent(), '변환이 완료되었습니다.');
      assert.equal(await session.ui.locator('#warning-count').textContent(), '확인된 경고가 없습니다.');
      assert.ok(await session.ui.locator('#warning-details').isHidden());
      assert.equal(await session.ui.locator('#debug-details').evaluate(el => el.open), false);
    }
  } finally { await session.page.close(); }
});

test('Only unprocessable or failed stylesheets warn; a loaded external CSS URL does not', async () => {
  const session = await openSession({ routes: {
    'https://assets.example.test/good.css': { contentType: 'text/css', body: 'p { color: rgb(12,34,56) }' },
    'https://assets.example.test/missing.css': { status: 404, contentType: 'text/plain', body: 'missing', delayMs: 50 }
  } });
  try {
    for (const [source, warned] of [['./bootstrap.min.css', true], ['https://assets.example.test/good.css', false], ['https://assets.example.test/missing.css', true]]) {
      await choose(session, 'external.html', `<link rel="stylesheet" href="${source}">${htmlFor('CSS')}`);
      await convertOnce(session);
      const result = outcomeFor(session);
      assert.equal(result.status, warned ? 'SUCCESS_WITH_WARNINGS' : 'SUCCESS', JSON.stringify({ source, raw: session.replies.filter(m => m.type === 'CONVERSION_COMPLETE').at(-1).payload.report.warnings }));
      assert.equal(result.warnings.some(w => w.code === 'EXTERNAL_RESOURCE' && w.detail.resource === source), warned);
      assert.equal(await session.ui.locator('#warning-details').evaluate(el => el.open), false);
    }
  } finally { await session.page.close(); }
});

test('100 identical font fallbacks become one cause with accurate occurrences and representative element locations', async () => {
  const session = await openSession();
  try {
    await choose(session, 'font.html', `<style>body{margin:0;font-family:MissingExampleFont}p{margin:0}</style><main>${Array.from({ length: 100 }, (_, i) => `<p id="text-${i}">Test</p>`).join('')}</main>`);
    await convertOnce(session);
    const warnings = outcomeFor(session).warnings.filter(w => w.sourceCode === 'FONT_REPLACED');
    assert.equal(warnings.length, 1); assert.equal(warnings[0].count, 100);
    assert.equal(warnings[0].detail.originalFont, 'MissingExampleFont'); assert.equal(warnings[0].detail.fallbackFont, 'Inter');
    assert.equal(warnings[0].locations.length, 5); assert.ok(warnings[0].locations.includes('p#text-0'));
    assert.equal(await session.ui.locator('#status').textContent(), '변환이 완료되었습니다. 일부 항목을 확인해 주세요.');
    await session.ui.locator('#warning-summary').click();
    assert.match(await session.ui.locator('#warnings').textContent(), /글꼴 대체 · 100회/);
    await choose(session, 'clean.html'); assert.ok(await session.ui.locator('#report').isHidden());
    await convertOnce(session); assert.equal(outcomeFor(session).warningCount, 0);
  } finally { await session.page.close(); }
});

test('Actual failed image decoding and rejected Figma image creation warn while retaining the result Frame', async () => {
  const session = await openSession({ routes: { 'https://assets.example.test/missing.png': { status: 404, body: 'missing' } } });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  try {
    await choose(session, 'image.html', `${htmlFor('Image')}<img id="photo" src="https://assets.example.test/missing.png" width="40" height="40">`);
    await convertOnce(session);
    assert.ok(outcomeFor(session).warnings.some(w => w.code === 'IMAGE_ERROR' && w.locations.includes('img#photo') && w.detail.resource.includes('missing.png')));
    const createImage = session.mock.figma.createImage;
    session.mock.figma.createImage = () => { throw new Error('Image API rejected'); };
    await choose(session, 'image-api.html', `${htmlFor('Image')}<img id="photo" src="${png}" width="40" height="40">`);
    await convertOnce(session);
    assert.ok(outcomeFor(session).warnings.some(w => w.sourceCode === 'IMAGE_PLACEHOLDER'));
    assert.ok(!outcomeFor(session).warnings.some(w => w.sourceCode === 'IMAGE_LOAD'), 'The valid PNG decoded before the API rejected it');
    assert.equal(outcomeFor(session).result.frameCreated, true);
    session.mock.figma.createImage = createImage;
  } finally { await session.page.close(); }
});

test('Ignored backdrop-filter reports its value and aria label; hidden and disabled-style targets do not warn', async () => {
  const session = await openSession();
  const content = `${htmlFor('Style')}<div aria-label="Preview" style="width:100px;height:20px;backdrop-filter:blur(4px)">Blur</div><div style="display:none;backdrop-filter:blur(9px)">Hidden</div>`;
  try {
    await choose(session, 'unsupported.html', content); await convertOnce(session);
    const warnings = outcomeFor(session).warnings.filter(w => w.code === 'UNSUPPORTED_STYLE');
    assert.equal(warnings.length, 1); assert.equal(warnings[0].detail.cssProperty, 'backdrop-filter');
    assert.deepEqual(warnings[0].locations, ['div[aria-label="Preview"]']);
    await session.ui.locator('#styles').uncheck(); await convertOnce(session);
    assert.ok(!outcomeFor(session).warnings.some(w => w.code === 'UNSUPPORTED_STYLE'));
  } finally { await session.page.close(); }
});

test('SVG and child failures finish with warnings and surviving content, while sizing failures keep retries enabled', async () => {
  const session = await openSession({ mockOptions: { failSvg: true, failText: 'omit-this' } });
  try {
    await choose(session, 'partial.html', `${htmlFor('Keep')}<p id="omit">omit-this</p><svg id="icon" width="20" height="20"><path d="M0 0L20 20"/></svg>`);
    await convertOnce(session); await assertUnlocked(session, 'success');
    const outcome = outcomeFor(session);
    assert.equal(outcome.status, 'SUCCESS_WITH_WARNINGS'); assert.equal(outcome.result.frameCreated, true);
    assert.ok(outcome.warnings.some(w => w.code === 'SVG_ERROR' && w.locations.includes('svg#icon')));
    assert.ok(outcome.warnings.some(w => w.sourceCode === 'NODE_FAILED' && w.locations.includes('p#omit')));
    assert.equal(session.mock.figma.currentPage.children.length, 1);
    await choose(session, 'sizing.html', `${htmlFor('Sizing')}<div style="display:flex; flex-direction:column"><p style="height:100%;margin:0">Fill</p></div>`);
    await convertOnce(session); await assertUnlocked(session, 'success');
    assert.ok(outcomeFor(session).warnings.some(w => w.code === 'SIZING_FALLBACK'));
  } finally { await session.page.close(); }
});

test('A rejected replacement preserves the valid selection and its accurately named report', async () => {
  const session = await openSession();
  try {
    await choose(session, 'valid.html'); await convertOnce(session);
    await session.ui.locator('#file').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') });
    assert.equal(await session.ui.locator('#status').textContent(), 'HTML 파일만 업로드할 수 있습니다.');
    assert.equal(await session.ui.locator('#report-file').textContent(), 'valid.html');
    assert.equal(await session.ui.locator('#filename').textContent(), 'valid.html');
    assert.ok(await session.ui.locator('#convert').isEnabled());
    await convertOnce(session); assert.equal(outcomeFor(session).fileName, 'valid.html');
    await choose(session, 'valid.html'); await convertOnce(session); assert.equal(outcomeFor(session).status, 'SUCCESS');
  } finally { await session.page.close(); }
});

test('A used web font with a confirmed loading error produces an external-resource warning', async () => {
  const session = await openSession({ routes: { 'https://assets.example.test/missing.woff2': { status: 404, body: 'missing' } } });
  try {
    await choose(session, 'web-font.html', '<style>@font-face{font-family:MissingWebFont;src:url(https://assets.example.test/missing.woff2)}body{font-family:MissingWebFont;margin:0}</style><p>Web Font</p>');
    await convertOnce(session);
    assert.ok(outcomeFor(session).warnings.some(w => w.sourceCode === 'WEB_FONT_LOAD' && w.detail.originalFont.includes('MissingWebFont')));
    await assertUnlocked(session, 'success');
  } finally { await session.page.close(); }
});

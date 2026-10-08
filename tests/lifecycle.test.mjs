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
async function openSession({ failFrameOnce = false, corruptReport = false, sourceParent = false } = {}) {
  const page = await browser.newPage();
  await page.goto(base);
  const ui = page.frames().find(frame => frame.url() === `${base}/ui`);
  await ui.locator('#file').waitFor();
  const mock = createFigmaMock(), requests = [], replies = [], deliveries = [], heldTerminals = [];
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
    if (corruptReport && delivered.type === 'CONVERSION_COMPLETE') delete delivered.payload.report.warningGroups;
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
    const text = await session.ui.locator('#warnings').textContent();
    for (const message of ['Debug:', 'computed backgroundImage:', 'background layers: 4', 'layer 4: solid #FFFFFF', 'figma fills: 4', 'Grid Line fallback: 3']) assert.ok(text.includes(message), message);
    assert.ok(await session.ui.locator('#warnings li').evaluateAll(items => items.some(item => item.style.whiteSpace === 'pre-line')));
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
    assert.ok((await session.ui.locator('#status').textContent()).includes('Lifecycle root failure'));
    assert.equal(session.mock.figma.currentPage.children.length, 0);
    await choose(session, 'retry.html', htmlFor('retry.html'), true);
    assert.equal(await session.ui.locator('#status').getAttribute('data-state'), 'idle');
    await convertOnce(session); await assertUnlocked(session, 'success');
    assert.equal(session.mock.figma.currentPage.children.length, 1);
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
    assert.equal(notificationErrors.length, 2);
    assert.equal(mock.figma.currentPage.children.length, 2);
  } finally { await session.page.close(); }
});

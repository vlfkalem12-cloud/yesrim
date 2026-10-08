import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createFigmaMock } from './figma-mock.mjs';

let browser, server, base, mainBundle, oldMain;
const baseline = process.env.BATCH_BASELINE_SRC;
before(async () => {
  const ui = await readFile('dist/ui.html', 'utf8'); mainBundle = await readFile('dist/code.js', 'utf8');
  if (baseline) oldMain = (await build({ entryPoints: [resolve(baseline, 'code.ts')], bundle: true, write: false, format: 'iife', target: 'es2020' })).outputFiles[0].text;
  server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url === '/ui' ? ui : '<!doctype html><iframe src="/ui" width="440" height="1200"></iframe>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH || await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined);
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] }); await mkdir('test-results', { recursive: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
const basic = label => `<style>body{margin:0;font-family:Inter}p{margin:0}</style><main><p>${label}</p></main>`;
const file = (name, content = basic(name)) => ({ name, content });
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for test gate'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function session({ failAt = [], corruptAt = [], moveViewport = false, rejectBatch = false } = {}) {
  const page = await browser.newPage(); await page.route('https://fonts.googleapis.com/**', route => route.abort()); await page.goto(base);
  const ui = page.frames().find(frame => frame.url() === `${base}/ui`); await ui.locator('#file').waitFor();
  const mock = createFigmaMock(), requests = [], replies = [], deliveries = [], held = [], timeline = [], artifacts = new Map();
  let hold = false, createCount = 0, active = 0, maxActive = 0, failPresentation = false;
  const zoom = mock.figma.viewport.scrollAndZoomIntoView;
  mock.figma.viewport.scrollAndZoomIntoView = function (nodes) {
    if (failPresentation) { failPresentation = false; throw new Error('Injected root completion failure'); }
    zoom.call(this, nodes); if (moveViewport) this.center = { x: this.center.x + 2000, y: this.center.y + 1000 };
  };
  const deliver = message => {
    const promise = ui.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: { pluginMessage: message }, source: null })), message);
    deliveries.push(promise); promise.catch(() => {});
  };
  mock.figma.ui.postMessage = message => {
    replies.push(structuredClone(message)); timeline.push(['main', message.type, message.itemId]);
    const copy = structuredClone(message);
    if (hold && ['CONVERSION_COMPLETE', 'CONVERSION_ERROR'].includes(copy.type)) held.push(copy); else deliver(copy);
  };
  runInNewContext(mainBundle, { figma: mock.figma, __html__: '', setTimeout, Uint8Array, console: { warn() {}, info() {} } });
  await page.exposeFunction('toMain', async original => {
    const message = structuredClone(original); requests.push(original); timeline.push(['ui', message.type, message.itemId]);
    if (message.type === 'BATCH_START' && rejectBatch) { deliver({ type: 'BATCH_ERROR', batchId: message.batchId, message: 'Injected batch start failure' }); return; }
    if (message.type === 'CREATE_FIGMA') {
      const imageStart = mock.images.length, svgStart = mock.svgImports.length, fontStart = mock.fontLoads.length;
      createCount++; if (corruptAt.includes(createCount)) message.payload = {};
      failPresentation = failAt.includes(createCount); active++; maxActive = Math.max(maxActive, active);
      try { await mock.figma.ui.onmessage(message); } finally { active--; artifacts.set(message.requestId, { images: mock.images.slice(imageStart).map(bytes => Array.from(bytes)), svg: mock.svgImports.slice(svgStart), fonts: mock.fontLoads.slice(fontStart) }); }
    } else await mock.figma.ui.onmessage(message);
  });
  await page.evaluate(() => window.addEventListener('message', event => {
    if (event.source === document.querySelector('iframe').contentWindow && event.data?.pluginMessage) void window.toMain(event.data.pluginMessage);
  }));
  return { page, ui, mock, requests, replies, deliveries, timeline, artifacts, get maxActive() { return maxActive; },
    hold() { hold = true; }, release() { hold = false; held.splice(0).forEach(deliver); },
    async drain() { await Promise.all(deliveries); } };
}
async function choose(s, files, drop = false, ready = true) {
  if (drop) await s.ui.evaluate(files => {
    const data = new DataTransfer(); files.forEach(f => data.items.add(new File([f.content], f.name, { type: 'text/html' })));
    document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  }, files);
  else await s.ui.locator('#file').setInputFiles(files.map(f => ({ name: f.name, mimeType: 'text/html', buffer: Buffer.from(f.content) })));
  if (ready) await s.ui.waitForFunction(() => !document.getElementById('convert').disabled && document.getElementById('status').dataset.state === 'idle');
}
async function convert(s) {
  await s.ui.locator('#convert').click();
  await s.ui.waitForFunction(() => ['success', 'error'].includes(document.getElementById('status').dataset.state)); await s.drain();
}
const states = s => s.ui.locator('#file-list li').evaluateAll(rows => rows.map(row => row.dataset.state));
const creates = s => s.requests.filter(m => m.type === 'CREATE_FIGMA');
const terminals = s => s.replies.filter(m => ['CONVERSION_COMPLETE', 'CONVERSION_ERROR'].includes(m.type));
async function unlocked(s) {
  assert.ok(await s.ui.locator('#file').isEnabled()); assert.ok(await s.ui.locator('#convert').isEnabled());
  assert.equal(await s.ui.locator('#file').inputValue(), ''); assert.ok(await s.ui.locator('#cancel').isHidden());
  assert.equal(await s.ui.locator('#dropzone').getAttribute('aria-disabled'), 'false');
}
async function viewportFor(s, index, width, height) {
  const row = s.ui.locator('#file-list li').nth(index); await row.locator('summary').click();
  await row.locator('[data-dimension="width"]').fill(String(width)); await row.locator('[data-dimension="height"]').fill(String(height));
}
function snapshot(node, root = true) {
  const output = {};
  // Compare every enumerable API value including range styles, effects, geometry and sizing.
  for (const key of [...new Set([...Object.keys(node), 'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutWrap', 'fontName', 'characters', 'textAutoResize', 'numberOfFixedChildren'])].sort()) {
    if (['id', 'parent', 'children', 'originalName'].includes(key) || typeof node[key] === 'function' || (root && ['x', 'y'].includes(key))) continue;
    if (key === 'rangeStyles') {
      output[key] = node.rangeStyles.map(({ loadedFonts, ...range }) => {
        if (range.property === 'fontName') assert.ok(loadedFonts.includes(`${range.value.family}|${range.value.style}`), 'Range font was loaded before applying it');
        return JSON.parse(JSON.stringify(range));
      });
    } else output[key] = JSON.parse(JSON.stringify(node[key]) || 'null');
  }
  output.metadata = Object.fromEntries(['html-source', 'html-type', 'html-fixed-position', 'html-grid', 'html-absolute', 'html-background-grid-line'].map(key => [key, node.getPluginData(key)]));
  output.children = node.children.map(child => snapshot(child, false)); return output;
}

test('1 HTML uses the existing message path and viewport-centered placement', async () => {
  const s = await session(); try {
    await choose(s, [file('one.HTM')]); await convert(s); await unlocked(s);
    assert.equal(creates(s).length, 1); assert.equal(creates(s)[0].batchId, undefined);
    assert.equal(s.requests.some(m => m.type === 'BATCH_START'), false);
    const root = s.mock.figma.currentPage.children[0]; assert.deepEqual([root.x, root.y], [1000 - root.width / 2, 800 - root.height / 2]);
    assert.deepEqual(await states(s), ['SUCCESS']); assert.ok(await s.ui.locator('#batch-summary').isHidden());
  } finally { await s.page.close(); }
});

test('3 dropped HTML files produce independent roots in upload order, 120px apart from a stable Canvas anchor', async () => {
  const s = await session({ moveViewport: true }); try {
    const previous = s.mock.figma.createFrame(); previous.name = 'Existing user frame'; previous.x = 77; previous.y = 88;
    await choose(s, [file('Z.html'), file('A.htm'), file('M.html')], true); await convert(s); await unlocked(s);
    assert.deepEqual(creates(s).map(m => m.fileName), ['Z.html', 'A.htm', 'M.html']);
    const roots = s.mock.figma.currentPage.children.slice(1); assert.equal(roots.length, 3);
    assert.deepEqual([roots[0].x, roots[0].y], [1000 - roots[0].width / 2, 800 - roots[0].height / 2]);
    for (let i = 1; i < roots.length; i++) assert.deepEqual([roots[i].x, roots[i].y], [roots[i - 1].x + roots[i - 1].width + 120, roots[0].y]);
    assert.deepEqual([previous.removed, previous.x, previous.y], [false, 77, 88]); assert.deepEqual(Array.from(s.mock.figma.currentPage.selection), roots);
    assert.equal(s.maxActive, 1); assert.deepEqual(await states(s), ['SUCCESS', 'SUCCESS', 'SUCCESS']);
    assert.match(await s.ui.locator('#batch-summary').textContent(), /총 3개 파일 · 정상 완료 3개/);
  } finally { await s.page.close(); }
});

test('10 files wait for each terminal before parsing the next file and show progress, locked controls and cleanup', async () => {
  const s = await session(); try {
    await choose(s, Array.from({ length: 10 }, (_, i) => file(`${i}.html`)));
    assert.equal(await s.ui.locator('#file-list-title').textContent(), '선택한 파일 (10/10)');
    s.hold(); await s.ui.locator('#convert').click();
    await s.ui.waitForFunction(() => document.querySelector('#file-list li').dataset.state === 'CONVERTING');
    await until(() => terminals(s).length === 1); // Hold an actual terminal before asserting that the queue is blocked.
    assert.equal(creates(s).length, 1); assert.deepEqual(await states(s), ['CONVERTING', ...Array(9).fill('WAITING')]);
    assert.match(await s.ui.locator('#status').textContent(), /1 \/ 10개 파일 처리 중 · 완료 0개/);
    assert.ok(await s.ui.locator('#file').isDisabled()); assert.ok(await s.ui.locator('#convert').isDisabled());
    assert.equal(await s.ui.locator('.remove-file').count(), 0); assert.ok(await s.ui.locator('.file-viewport input').first().isDisabled());
    await choose(s, [file('ignored.html')], true, false); assert.equal(await s.ui.locator('#file-list li').count(), 10);
    s.release(); await s.ui.waitForFunction(() => document.getElementById('status').dataset.state === 'success'); await s.drain();
    assert.equal(creates(s).length, 10); assert.equal(s.maxActive, 1); assert.equal(s.mock.figma.currentPage.children.length, 10);
    assert.deepEqual(await states(s), Array(10).fill('SUCCESS')); await unlocked(s);
    const actions = s.timeline.filter(([side, type]) => (side === 'ui' && type === 'CREATE_FIGMA') || (side === 'main' && type === 'CONVERSION_COMPLETE'));
    assert.deepEqual(actions.map(([side]) => side), Array.from({ length: 10 }, () => ['ui', 'main']).flat());
    assert.equal(await s.ui.locator('#render-host iframe').count(), 0); assert.equal(await s.ui.locator('#render-host').evaluate(el => el.childElementCount), 0);
    await s.ui.locator('body').screenshot({ path: 'test-results/batch-ui.png' });
  } finally { await s.page.close(); }
});

test('11 files, mixed extensions, oversize, empty and unreadable replacements preserve the valid selection atomically', async () => {
  const s = await session(); try {
    await choose(s, [file('valid.html'), file('valid.htm')]);
    const original = await s.ui.locator('#file-list li').evaluateAll(rows => rows.map(row => row.dataset.itemId));
    for (const [files, message, drop] of [
      [Array.from({ length: 11 }, (_, i) => file(`${i}.html`)), 'HTML 파일은 최대 10개까지 선택할 수 있습니다.', false],
      [[file('good.html'), file('bad.txt')], 'HTML 파일만 업로드할 수 있습니다.', true],
      [[file('empty.html', '')], 'HTML 파일이 비어 있습니다.', false],
      [[file('large.html', 'x'.repeat(5 * 1024 * 1024 + 1))], '파일이 5MB 제한을 초과했습니다.', false]
    ]) {
      await choose(s, files, drop, false); await s.ui.waitForFunction(() => document.getElementById('status').dataset.state === 'error');
      assert.ok((await s.ui.locator('#status').textContent()).includes(message));
      assert.deepEqual(await s.ui.locator('#file-list li').evaluateAll(rows => rows.map(row => row.dataset.itemId)), original);
      await unlocked(s);
    }
    await s.ui.evaluate(() => { window.readText = FileReader.prototype.readAsText; FileReader.prototype.readAsText = function () { queueMicrotask(() => this.dispatchEvent(new Event('error'))); }; });
    await choose(s, [file('read.html')], false, false); await s.ui.waitForFunction(() => document.getElementById('status').textContent.includes('파일 읽기'));
    await s.ui.evaluate(() => { FileReader.prototype.readAsText = window.readText; });
    assert.deepEqual(await s.ui.locator('#file-list li').evaluateAll(rows => rows.map(row => row.dataset.itemId)), original);
    await convert(s); assert.equal(s.mock.figma.currentPage.children.length, 2);
  } finally { await s.page.close(); }
});

test('Files can be removed before conversion while preserving the remaining order', async () => {
  const s = await session(); try {
    await choose(s, [file('1.html'), file('2.html'), file('3.html')]); await s.ui.locator('.remove-file').nth(1).click();
    assert.equal(await s.ui.locator('#file-list-title').textContent(), '선택한 파일 (2/10)'); await convert(s);
    assert.deepEqual(creates(s).map(m => m.fileName), ['1.html', '3.html']);
    await choose(s, [file('last.html')]); await s.ui.locator('.remove-file').click(); assert.ok(await s.ui.locator('#convert').isDisabled());
  } finally { await s.page.close(); }
});

test('A middle root failure removes only its partial tree; the following file completes', async () => {
  const s = await session({ failAt: [2] }); try {
    await choose(s, [file('first.html'), file('failure.html'), file('last.html')]); await convert(s); await unlocked(s);
    assert.deepEqual(await states(s), ['SUCCESS', 'ERROR', 'SUCCESS']); assert.equal(s.mock.figma.currentPage.children.length, 2);
    const roots = s.mock.figma.currentPage.children; assert.equal(roots[1].x, roots[0].x + roots[0].width + 120);
    assert.match(await s.ui.locator('#batch-summary').textContent(), /정상 완료 2개 · 경고 포함 완료 0개 · 실패 1개/);
    await s.ui.locator('.file-detail').nth(1).click(); assert.equal(await s.ui.locator('#report-file').textContent(), 'failure.html');
    assert.equal(await s.ui.locator('#report').getAttribute('data-result'), 'ERROR'); assert.match(await s.ui.locator('#report-error').textContent(), /Injected root/);
  } finally { await s.page.close(); }
});

test('A parser failure is a per-file result and continues in order without invoking the Converter', async () => {
  const s = await session(); try {
    await choose(s, [file('first.html'), file('hidden.html', '<style>body{display:none}</style><p>hidden</p>'), file('last.html')]); await convert(s);
    assert.deepEqual(await states(s), ['SUCCESS', 'ERROR', 'SUCCESS']); assert.deepEqual(creates(s).map(m => m.fileName), ['first.html', 'last.html']);
    assert.equal(s.requests.filter(m => m.type === 'FILE_ANALYSIS_ERROR').length, 1); assert.equal(s.mock.figma.currentPage.children.length, 2);
    assert.equal(s.replies.at(-1).summary.errors, 1); assert.equal(s.replies.at(-1).summary.waiting, 0);
  } finally { await s.page.close(); }
});

test('Warnings, Debug, computed CSS, image assets and intermediate data remain independent per file', async () => {
  const s = await session(); const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  try {
    await s.ui.locator('#debug').check();
    await choose(s, [file('warnings.html', `${basic('Warn')}<link rel="stylesheet" href="./missing.css"><div id="same" style="width:80px;height:30px;color:red;backdrop-filter:blur(2px)">A</div><img src="${png}" width="8" height="8">`), file('clean.html', `${basic('Clean')}<div id="same" style="width:100px;height:40px;color:blue">B</div>`)]);
    await convert(s); const done = terminals(s); assert.equal(done[0].payload.outcome.status, 'SUCCESS_WITH_WARNINGS', JSON.stringify(done[0])); assert.equal(done[1].payload.outcome.status, 'SUCCESS');
    assert.equal(done[1].payload.outcome.warningCount, 0); assert.ok(done[0].payload.outcome.warnings.some(w => w.code === 'UNSUPPORTED_STYLE'));
    assert.ok(Object.keys(creates(s)[0].payload.assets).length > 0); assert.equal(Object.keys(creates(s)[1].payload.assets).length, 0);
    await s.ui.locator('.file-detail').first().click(); const firstDebug = await s.ui.locator('#debug-warnings').textContent();
    assert.equal(await s.ui.locator('#report-file').textContent(), 'warnings.html'); assert.ok(await s.ui.locator('#json').isHidden());
    await s.ui.locator('.file-detail').nth(1).click(); assert.equal(await s.ui.locator('#report-file').textContent(), 'clean.html');
    assert.equal(await s.ui.locator('#warning-count').textContent(), '확인된 경고가 없습니다.'); assert.ok(await s.ui.locator('#json').isVisible());
    assert.ok(!((await s.ui.locator('#debug-warnings').textContent()).includes('missing.css'))); assert.ok(firstDebug.includes('missing.css'));
    const flatten = node => [node, ...node.children.flatMap(flatten)];
    assert.equal(flatten(creates(s)[0].payload.root).find(n => n.text === 'A').style.color.r, 1);
    assert.equal(flatten(creates(s)[1].payload.root).find(n => n.text === 'B').style.color.b, 1);
  } finally { await s.page.close(); }
});

test('Per-file viewports preserve 360px and 1920px roots and use their actual widths for placement', async () => {
  const s = await session(); try {
    await choose(s, [file('mobile.html'), file('desktop.html'), file('default.html')]);
    await viewportFor(s, 0, 360, 844); await viewportFor(s, 1, 1920, 900);
    const field = s.ui.locator('#file-list li').first().locator('[data-dimension="width"]'); await field.fill('0');
    assert.ok(await s.ui.locator('#convert').isDisabled()); assert.ok(await s.ui.locator('#file-viewport-error').isVisible()); await field.fill('360');
    await convert(s); const roots = s.mock.figma.currentPage.children;
    assert.deepEqual(roots.map(n => n.width), [360, 1920, 1440]);
    assert.deepEqual(creates(s).map(m => [m.payload.options.viewport, m.payload.options.viewportHeight]), [[360, 844], [1920, 900], [1440, 900]]);
    assert.equal(roots[1].x, roots[0].x + 360 + 120); assert.equal(roots[2].x, roots[1].x + 1920 + 120);
  } finally { await s.page.close(); }
});

test('Duplicate filenames, repeated batches and direct retries use distinct item, file-request and batch identities', async () => {
  const s = await session(); try {
    const files = [file('same.html', basic('A')), file('same.html', basic('B'))];
    await choose(s, files); await convert(s); const old = creates(s).slice();
    assert.notEqual(old[0].itemId, old[1].itemId); assert.equal(new Set(old.map(m => m.requestId)).size, 2);
    const textNodes = node => [node, ...node.children.flatMap(textNodes)]; assert.ok(textNodes(s.mock.figma.currentPage.children[0]).some(node => node.characters === 'A')); assert.ok(textNodes(s.mock.figma.currentPage.children[1]).some(node => node.characters === 'B'));
    await choose(s, files, true); assert.ok(await s.ui.locator('#report').isHidden()); assert.ok(await s.ui.locator('#batch-summary').isHidden());
    assert.deepEqual(await states(s), ['WAITING', 'WAITING']); await convert(s); await convert(s);
    assert.equal(s.mock.figma.currentPage.children.length, 6); assert.equal(new Set(creates(s).map(m => m.batchId)).size, 3);
    assert.equal(new Set(creates(s).map(m => m.requestId)).size, 6); await unlocked(s);
  } finally { await s.page.close(); }
});

test('Delayed terminal, progress, batch-complete and stale cancellation events cannot change a new batch', async () => {
  const s = await session(); try {
    await choose(s, [file('old1.html'), file('old2.html')]); await convert(s); const oldReplies = s.replies.slice(); const oldId = creates(s)[0].batchId;
    s.hold(); await choose(s, [file('new1.html'), file('new2.html')]); await s.ui.locator('#convert').click();
    await s.ui.waitForFunction(() => document.querySelector('#file-list li').dataset.state === 'CONVERTING');
    for (const message of oldReplies) await s.ui.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: { pluginMessage: message } })), message);
    const current = creates(s).at(-1);
    await s.ui.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: { pluginMessage: message } })), current); // Reflected outbound requests must never settle a file.
    await s.ui.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: { pluginMessage: message } })), { ...oldReplies.find(m => m.type === 'CONVERSION_COMPLETE'), requestId: current.requestId, batchId: current.batchId, itemId: 'wrong-item' });
    await s.mock.figma.ui.onmessage({ type: 'CANCEL', batchId: oldId });
    assert.deepEqual(await states(s), ['CONVERTING', 'WAITING']); assert.equal(await s.ui.locator('#status').getAttribute('data-state'), 'converting');
    assert.ok(await s.ui.locator('#report').isHidden()); assert.ok(await s.ui.locator('#batch-summary').isHidden());
    s.release(); await s.ui.waitForFunction(() => document.getElementById('status').dataset.state === 'success'); await s.drain();
    assert.deepEqual(await states(s), ['SUCCESS', 'SUCCESS']);
  } finally { await s.page.close(); }
});

test('Whole-batch cancellation preserves completed roots, leaves remaining files unprocessed and permits retry', async () => {
  const s = await session(); try {
    await choose(s, [file('1.html'), file('2.html'), file('3.html')]); s.hold(); await s.ui.locator('#convert').click();
    await until(() => terminals(s).length === 1);
    await s.ui.locator('#cancel').click(); s.release();
    await s.ui.waitForFunction(() => document.getElementById('status').dataset.state === 'error'); await s.drain();
    assert.deepEqual(await states(s), ['SUCCESS', 'WAITING', 'WAITING']); assert.equal(s.mock.figma.currentPage.children.length, 1);
    assert.match(await s.ui.locator('#batch-summary').textContent(), /미처리 2개/); await unlocked(s);
    await convert(s); assert.deepEqual(await states(s), ['SUCCESS', 'SUCCESS', 'SUCCESS']); assert.equal(s.mock.figma.currentPage.children.length, 4);
  } finally { await s.page.close(); }
});

test('All file failures and whole-batch start failure release controls without claiming a file result', async () => {
  const s = await session({ corruptAt: [1, 2] }); const rejected = await session({ rejectBatch: true }); try {
    await choose(s, [file('1.html'), file('2.html')]); await convert(s); assert.deepEqual(await states(s), ['ERROR', 'ERROR']); await unlocked(s);
    assert.equal(await s.ui.locator('#status').getAttribute('data-state'), 'error'); assert.equal(s.mock.figma.currentPage.children.length, 0);
    await choose(rejected, [file('1.html'), file('2.html')]); await convert(rejected); await unlocked(rejected);
    assert.deepEqual(await states(rejected), ['WAITING', 'WAITING']); assert.match(await rejected.ui.locator('#status').textContent(), /전체 변환/);
  } finally { await s.page.close(); await rejected.page.close(); }
});

test('Main rejects invalid size, duplicate IDs and out-of-order file requests without advancing its queue', async () => {
  const s = await session(); try {
    await choose(s, [file('payload.html')]); await convert(s); const payload = creates(s)[0].payload;
    const mock = createFigmaMock(), sent = []; mock.figma.ui.postMessage = m => sent.push(m);
    runInNewContext(mainBundle, { figma: mock.figma, __html__: '', setTimeout, Uint8Array, console: { warn() {}, info() {} } });
    const send = m => mock.figma.ui.onmessage(m);
    await send({ type: 'BATCH_START', batchId: 'oversize', items: Array.from({ length: 11 }, (_, i) => ({ itemId: String(i), fileName: 'x.html' })) });
    await send({ type: 'BATCH_START', batchId: 'duplicate', items: [{ itemId: 'a', fileName: 'a' }, { itemId: 'a', fileName: 'a' }] });
    const center = mock.figma.viewport.center;
    Object.defineProperty(mock.figma.viewport, 'center', { configurable: true, get() { throw new Error('Canvas center unavailable'); } });
    await send({ type: 'BATCH_START', batchId: 'center-error', items: [{ itemId: 'a', fileName: 'a' }, { itemId: 'b', fileName: 'b' }] });
    Object.defineProperty(mock.figma.viewport, 'center', { configurable: true, writable: true, value: center });
    assert.deepEqual(sent.map(m => m.type), ['BATCH_ERROR', 'BATCH_ERROR', 'BATCH_ERROR']);
    await send({ type: 'BATCH_START', batchId: 'ok', items: [{ itemId: 'a', fileName: 'same' }, { itemId: 'b', fileName: 'same' }] });
    await send({ type: 'CREATE_FIGMA', requestId: 'wrong', batchId: 'ok', itemId: 'b', payload }); assert.equal(mock.figma.currentPage.children.length, 0);
    await send({ type: 'CREATE_FIGMA', requestId: 'a', batchId: 'ok', itemId: 'a', payload });
    await send({ type: 'CREATE_FIGMA', requestId: 'stale', batchId: 'old', itemId: 'a', payload });
    await send({ type: 'CREATE_FIGMA', requestId: 'b', batchId: 'ok', itemId: 'b', payload });
    await send({ type: 'CREATE_FIGMA', requestId: 'extra', batchId: 'ok', payload });
    assert.equal(sent.at(-1).type, 'CONVERSION_ERROR'); assert.equal(mock.figma.currentPage.children.length, 2);
    mock.figma.viewport.scrollAndZoomIntoView = () => { throw new Error('Final zoom failure'); };
    await send({ type: 'BATCH_FINISH', batchId: 'ok', cancelled: false });
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1).summary)), { total: 2, success: 2, warnings: 0, errors: 0, waiting: 0, cancelled: false });
  } finally { await s.page.close(); }
});

test('Batch preserves the stable single conversion engine, schema, reports and all node/asset results for 12 real regression HTML files', { skip: !baseline }, async () => {
  for (const name of await readdir(baseline)) if (name.endsWith('.ts') && !['ui.ts', 'code.ts', 'types.ts'].includes(name))
    assert.equal(await readFile(`src/${name}`, 'utf8'), await readFile(resolve(baseline, name), 'utf8'), `${name}: protected conversion source is byte-identical`);
  assert.equal((await readFile('src/types.ts', 'utf8')).split('export interface BatchContext')[0], (await readFile(resolve(baseline, 'types.ts'), 'utf8')).split('export type UIMessage')[0], 'Intermediate JSON and report schema unchanged');
  const files = ['test/actual/09-01_A-pc-list.html', 'examples/mvp.html', 'test/dashboard-rendering-regression.html', 'test/form-controls-regression.html', 'test/fixed-position-regression.html', 'test/phase2-test.html', 'test/rendering-regression.html', 'test/gradient-regression.html', 'test/inline-accessibility-regression.html', 'test/layer-naming-regression.html', 'test/rich-text-regression.html', 'test/content-components-regression.html'];
  const evidence = [];
  // Two batches keep within the actual 10-file maximum and exercise repeated upload.
  const s = await session(); try {
    await s.ui.locator('#viewport-width').fill('1920'); await s.ui.locator('#debug').check();
    for (const chunk of [files.slice(0, 6), files.slice(6)]) {
      await choose(s, await Promise.all(chunk.map(async path => file(path.split('/').at(-1), await readFile(path, 'utf8')))));
      const start = creates(s).length, rootStart = s.mock.figma.currentPage.children.length; await convert(s);
      for (const [i, path] of chunk.entries()) {
        const request = creates(s)[start + i], reply = terminals(s).find(m => m.requestId === request.requestId);
        assert.equal(reply.type, 'CONVERSION_COMPLETE', `${path}: ${JSON.stringify(reply.payload)}`);
        const singleMock = createFigmaMock(), singleMessages = []; singleMock.figma.ui.postMessage = m => singleMessages.push(m);
        runInNewContext(oldMain, { figma: singleMock.figma, __html__: '', setTimeout, Uint8Array, console: { warn() {}, info() {} } });
        await singleMock.figma.ui.onmessage({ type: 'CREATE_FIGMA', requestId: `baseline-${i}`, fileName: request.fileName, payload: structuredClone(request.payload) });
        const singleReply = singleMessages.find(m => m.type === 'CONVERSION_COMPLETE'); assert.ok(singleReply, path);
        const root = s.mock.figma.currentPage.children[rootStart + i];
        // Normalize opaque image handles to corresponding image bytes instead of depending on global API counters.
        const normalize = node => JSON.stringify(node).replace(/"imageHash":"hash-\d+"/g, '"imageHash":"image-handle"');
        assert.deepEqual(JSON.parse(normalize(snapshot(root))), JSON.parse(normalize(snapshot(singleMock.figma.currentPage.children[0]))), `${path}: complete tree except root Canvas XY and opaque image IDs`);
        const before = JSON.parse(JSON.stringify(singleReply.payload.report)), after = JSON.parse(JSON.stringify(reply.payload.report)); before.durationMs = after.durationMs = 0;
        // Map runtime node identifiers by their already-verified tree positions; preserve all debug reasons and coordinates.
        const nodes = node => [node, ...node.children.flatMap(nodes)];
        const actualNodes = nodes(root), singleNodes = nodes(singleMock.figma.currentPage.children[0]);
        const ids = new Map(actualNodes.map((node, i) => [node.id, singleNodes[i].id]));
        const translate = text => text.replace(/\((\d+)\)/g, (match, id) => ids.has(id) ? `(${ids.get(id)})` : match);
        for (const entry of after.heightHierarchy || []) { entry.id = ids.get(entry.id) || entry.id; entry.parentId = ids.get(entry.parentId) || entry.parentId; entry.reason = translate(entry.reason); }
        for (const warning of after.warnings) if (['HEIGHT_SIZING', 'HEIGHT_LAYOUT'].includes(warning.code)) warning.message = translate(warning.message);
        assert.deepEqual(after, before, `${path}: per-file report and Debug`);
        assert.deepEqual(reply.payload.outcome, JSON.parse(JSON.stringify(singleReply.payload.outcome)), `${path}: grouped cause counts and locations`);
        assert.deepEqual(s.artifacts.get(request.requestId).images, singleMock.images.map(bytes => Array.from(bytes)), `${path}: image bytes`);
        assert.deepEqual(s.artifacts.get(request.requestId).svg, singleMock.svgImports, `${path}: serialized native SVG`);
        assert.deepEqual(s.artifacts.get(request.requestId).fonts, singleMock.fontLoads, `${path}: per-file font resolution/loading`);
        evidence.push({ file: path, nodes: reply.payload.report.total, width: root.width, warningCount: reply.payload.outcome.warningCount, identical: true });
      }
    }
    await writeFile('test-results/batch-regression.json', JSON.stringify({ baseline: '6b49a83', evidence, note: 'Chromium UI + Figma API mock; native Figma editing not tested' }, null, 2));
  } finally { await s.page.close(); }
});

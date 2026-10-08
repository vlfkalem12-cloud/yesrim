import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createFigmaMock, flatten } from './figma-mock.mjs';

const fixture = 'test/actual/09-01_A-pc-list.html';
const baseline = process.env.ACTUAL_HUG_BASELINE_SRC;
let html, browser, server, url, parser, converter, oldConverter, original;
const evidence = { file: fixture, actualFigmaExecuted: false, verification: 'Original HTML in Chromium + Figma API contract/box model; native Figma editing remains manual', faults: {} };
before(async () => {
  html = await readFile(fixture, 'utf8'); await mkdir('test-results', { recursive: true });
  parser = (await build({ entryPoints: ['src/parser.ts'], bundle: true, write: false, format: 'iife', globalName: 'Parser' })).outputFiles[0].text;
  await build({ entryPoints: ['src/converter.ts'], bundle: true, outfile: 'test-results/actual-nested-converter.mjs', format: 'esm', platform: 'node' });
  converter = await import('../test-results/actual-nested-converter.mjs');
  if (baseline) {
    await build({ entryPoints: [resolve(baseline, 'converter.ts')], bundle: true, outfile: 'test-results/actual-nested-baseline-converter.mjs', format: 'esm', platform: 'node' });
    oldConverter = await import('../test-results/actual-nested-baseline-converter.mjs');
  }
  server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<div id="host"></div>'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); url = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH || await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined);
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  original = await inspect();
});
after(async () => {
  await writeFile('test-results/actual-nested-hug.json', JSON.stringify(evidence, null, 2));
  await browser?.close(); await new Promise(done => server ? server.close(done) : done());
});
async function inspect(mutation = '', options = {}) {
  const page = await browser.newPage();
  try {
    // Deterministic offline font fallback. The uploaded file is unchanged; this is not IBM Plex/Figma font validation.
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.goto(url); await page.addScriptTag({ content: parser });
    return await page.evaluate(async ({ html, mutation, options }) => {
      const rendered = await Parser.renderHTML(html, 1440, 900, document.getElementById('host'));
      try {
        const root = rendered.document.body.firstElementChild;
        const tax = root.children[2], inner = tax.firstElementChild, list = inner.children[1], next = root.children[3], footer = root.children[6];
        if (mutation === 'add' || mutation === 'delete') { const copy = list.firstElementChild.cloneNode(true); list.append(copy); if (mutation === 'delete') copy.remove(); }
        if (mutation === 'long-text') list.firstElementChild.children[1].children[1].textContent = '상담 카드의 설명을 여러 줄로 늘려 상위 영역과 다음 Section의 이동을 확인합니다. '.repeat(25);
        const dom = Object.fromEntries(Object.entries({ Root: root, 'Tax Section': tax, 'Tax Inner': inner, 'Card List': list, 'Next Section': next, Footer: footer }).map(([name, element]) => {
          const rect = element.getBoundingClientRect(), style = rendered.document.defaultView.getComputedStyle(element);
          return [name, { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, display: style.display, flex: style.flex,
            boxSizing: style.boxSizing, margin: style.margin, maxWidth: style.maxWidth, height: style.height, minHeight: style.minHeight }];
        }));
        const doc = await Parser.parseRenderedHTML(rendered, { viewport: 1440, viewportHeight: 900, autoLayout: true, styles: true,
          optimizeWrappers: true, debug: false, ...options });
        return { dom, doc, rows: [...new Set([...list.children].map(child => child.getBoundingClientRect().top))].length };
      } finally { rendered.dispose(); }
    }, { html, mutation, options });
  } finally { await page.close(); }
}
async function convert(doc = original.doc, faults = {}, engine = converter) {
  const mock = createFigmaMock({ simulateAutoHeight: true, simulateAutoPosition: true, simulateSizingCoupling: true, resizeResetsHug: true, maxPluginDataBytes: 100000, ...faults });
  globalThis.figma = mock.figma;
  return { ...await engine.convertDocument(structuredClone(doc)), ...mock };
}
function targets(root) {
  return { Root: root, 'Tax Section': root.children[2], 'Tax Inner': root.children[2].children[0],
    'Card List': root.children[2].children[0].children[1], 'Next Section': root.children[3], Footer: root.children[6] };
}
const isTax = node => node.type === 'FRAME' && node.parent?.parent?.type === 'PAGE' && node.parent.children.indexOf(node) === 2;
const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1, `${label}: ${a} vs ${b}`);
function hierarchy(root) {
  return Object.fromEntries(Object.entries(targets(root)).map(([name, node]) => [name, { id: node.id, parentId: node.parent?.id,
    layoutMode: node.layoutMode, heightMode: node.layoutSizingVertical, height: node.height, y: node.y, width: node.width,
    primaryAxisSizingMode: node.primaryAxisSizingMode, counterAxisSizingMode: node.counterAxisSizingMode, positioning: node.layoutPositioning,
    reason: node.getPluginData('html-height-sizing') ? JSON.parse(node.getPluginData('html-height-sizing')).reason : undefined }]));
}
function cloneBox(node, figma, parent) {
  // API-double copy of the complete imported card tree; fonts/characters retain measured boxes.
  const copy = node.type === 'TEXT' ? figma.createText() : node.type === 'FRAME' ? figma.createFrame() : figma.createRectangle();
  copy.name = node.name; copy.layoutMode = node.layoutMode;
  for (const key of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing', 'counterAxisSpacing', 'strokesIncludedInLayout',
    'strokeTopWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'strokeRightWeight', 'minHeight', 'maxHeight', 'minWidth', 'maxWidth']) if (node[key] !== undefined) copy[key] = node[key];
  if (node.layoutMode === 'HORIZONTAL' && node.layoutWrap === 'WRAP') copy.layoutWrap = 'WRAP';
  if (node.type === 'TEXT') { copy.fontName = node.fontName; copy.characters = node.characters; }
  copy.resize(node.width, node.height); parent.appendChild(copy);
  for (const child of node.children) cloneBox(child, figma, copy);
  if (node.type === 'TEXT' || node.layoutMode !== 'NONE' || parent.layoutMode !== 'NONE') {
    copy.layoutSizingHorizontal = node.layoutSizingHorizontal; copy.layoutSizingVertical = node.layoutSizingVertical;
  }
  return copy;
}
function editCheck(result) {
  const t = targets(result.frame), before = hierarchy(result.frame), first = t['Card List'].children[0];
  const copy = cloneBox(first, result.figma, t['Card List']), added = hierarchy(result.frame), delta = first.height + t['Card List'].counterAxisSpacing;
  for (const name of ['Card List', 'Tax Inner', 'Tax Section']) near(added[name].height - before[name].height, delta, `${name} expands`);
  near(added['Next Section'].y - before['Next Section'].y, delta, 'next Section follows');
  assert.ok(added['Next Section'].y >= added['Tax Section'].y + added['Tax Section'].height);
  copy.remove(); assert.deepEqual(hierarchy(result.frame), before, 'Deleting the actual-card copy restores heights and positions');
  return { before, added, restored: hierarchy(result.frame), delta };
}

test('The unmodified uploaded HTML has the real block/centered ancestors, Wrap cards and flex:1 Footer', async () => {
  assert.equal(createHash('sha256').update(html).digest('hex'), 'd0ed7452148a49938b0dd003d790f997725c13fe19939a0a94acffff71f013ff');
  assert.equal(original.doc.root.children.length, 7);
  const tax = original.doc.root.children[2], inner = tax.children[0], list = inner.children[1];
  assert.equal(original.dom['Tax Section'].display, 'block'); assert.equal(original.dom['Tax Section'].boxSizing, 'content-box');
  assert.equal(original.dom['Tax Inner'].maxWidth, '1280px'); assert.match(original.dom['Tax Inner'].margin, /40px/);
  assert.equal(list.children.length, 6); assert.equal(original.rows, 2); assert.equal(original.dom.Footer.flex, '1 1 0%');
  assert.equal(tax.layout.direction, 'VERTICAL'); assert.equal(tax.layout.normalFlow.align, 'CENTER');
  for (const node of [tax, inner, list]) assert.equal(node.size.heightMode, 'HUG');
  evidence.dom = original.dom;
  evidence.originalAdded = (await inspect('add')).dom;
  evidence.originalRestored = (await inspect('delete')).dom;
  evidence.originalTextGrowth = (await inspect('long-text')).dom;
  assert.deepEqual(evidence.originalRestored, original.dom);
  assert.ok(evidence.originalAdded['Next Section'].rect.y > original.dom['Next Section'].rect.y);
  assert.ok(evidence.originalTextGrowth['Tax Section'].rect.height > original.dom['Tax Section'].rect.height);
  assert.ok(evidence.originalTextGrowth['Next Section'].rect.y >= evidence.originalTextGrowth['Tax Section'].rect.y + evidence.originalTextGrowth['Tax Section'].rect.height);
});

test('Final diagnostics distinguish every ancestor by actual parent ID/path and explain Root Fixed independently of Tax Hug', async () => {
  const doc = structuredClone(original.doc); doc.options.debug = true;
  const result = await convert(doc), t = targets(result.frame); evidence.initial = hierarchy(result.frame);
  for (const name of ['Tax Section', 'Tax Inner', 'Card List', 'Next Section']) {
    assert.equal(t[name].layoutSizingVertical, 'HUG', name); near(t[name].height, original.dom[name].rect.height, name);
  }
  near(t['Next Section'].y, original.dom['Next Section'].rect.y, 'next Y');
  assert.equal(t['Next Section'].layoutPositioning, 'AUTO'); assert.equal(t['Next Section'].parent, result.frame);
  assert.equal(result.frame.layoutMode, 'VERTICAL'); assert.equal(result.frame.layoutSizingVertical, 'FIXED');
  assert.match(evidence.initial.Root.reason, /Hug\/Fill dependency/); assert.match(evidence.initial.Root.reason, new RegExp(t.Footer.id));
  assert.match(evidence.initial['Tax Section'].reason, /Measured block margins\/alignment/);
  const entries = result.report.heightHierarchy;
  assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length, 'Generic selectors must not merge Frames');
  for (const name of ['Tax Section', 'Tax Inner', 'Card List', 'Next Section']) assert.equal(entries.find(entry => entry.id === t[name].id).heightMode, 'HUG');
  assert.equal(entries.find(entry => entry.id === t['Card List'].id).path, 'Root / 2 / 0 / 1');
  const saved = JSON.parse(result.frame.getPluginData('html-height-hierarchy'));
  const savedEntries = Array.isArray(saved) ? saved : saved.keys.flatMap(key => JSON.parse(result.frame.getPluginData(key)));
  assert.deepEqual(savedEntries, entries);
  assert.ok(result.report.warnings.some(w => w.code === 'HEIGHT_HIERARCHY' && w.category === 'Debug'));
});

test('Actual imported card boxes propagate 6 → 7 → 6 through the real ancestor chain while Root Fill policy remains unchanged', async () => {
  const result = await convert(); evidence.boxEdits = editCheck(result);
  assert.equal(result.frame.layoutSizingVertical, 'FIXED', 'Root/Fill policy is not silently changed');
  assert.equal(result.frame.minHeight, 4463); assert.equal(targets(result.frame)['Card List'].layoutWrap, 'WRAP');
});

test('An actual card description box growing after a Text edit expands Card/Wrap/ancestors and moves Next', async () => {
  const result = await convert(), t = targets(result.frame), before = hierarchy(result.frame), first = t['Card List'].children[0];
  const text = flatten(first.children[1]).findLast(node => node.type === 'TEXT'), previousHeight = text.height;
  text.characters += ' 긴 설명'.repeat(25); text.height = previousHeight + 240; // Box-only double has no native font engine.
  const after = hierarchy(result.frame);
  for (const name of ['Tax Section', 'Tax Inner', 'Card List']) near(after[name].height - before[name].height, 240, `${name} propagates text box`);
  near(after['Next Section'].y - before['Next Section'].y, 240, 'next follows Text');
  assert.ok(after['Next Section'].y >= after['Tax Section'].y + after['Tax Section'].height);
  evidence.textBoxEdits = { before, after, nativeFontMetricsSimulated: false };
});

test('A rejected Horizontal setter on the actual Tax Section must still apply its Vertical Hug', async () => {
  const faults = { rejectSizingAxis: (node, axis) => isTax(node) && axis === 'Horizontal' };
  const result = await convert(original.doc, faults); evidence.faults.horizontalRejected = editCheck(result);
  assert.ok(result.report.warnings.some(w => w.code === 'SIZING_API' && /Horizontal/.test(w.message)));
  if (oldConverter) {
    const old = await convert(original.doc, faults, oldConverter); assert.equal(targets(old.frame)['Tax Section'].layoutSizingVertical, 'FIXED');
    evidence.faults.horizontalRejected.old = hierarchy(old.frame);
  }
});

test('Final Hug readback restores the actual Tax Section if viewport finalization reset it, without promoting Fixed/Fill nodes', async () => {
  const faults = { afterResizeWithoutConstraints: root => {
    if (root.parent?.type === 'PAGE' && root.children.length === 7) root.children[2].primaryAxisSizingMode = 'FIXED';
  } };
  const result = await convert(original.doc, faults); evidence.faults.finalizationReset = editCheck(result);
  assert.equal(result.frame.layoutSizingVertical, 'FIXED'); assert.equal(targets(result.frame).Footer.layoutSizingVertical, 'FILL');
  if (oldConverter) {
    const old = await convert(original.doc, faults, oldConverter), t = targets(old.frame), before = hierarchy(old.frame);
    assert.equal(t['Tax Section'].layoutSizingVertical, 'FIXED'); assert.equal(t['Card List'].layoutSizingVertical, 'HUG');
    cloneBox(t['Card List'].children[0], old.figma, t['Card List']);
    assert.ok(t['Card List'].height > before['Card List'].height); assert.equal(t['Next Section'].y, before['Next Section'].y);
    evidence.faults.finalizationReset.oldBefore = before; evidence.faults.finalizationReset.oldAdded = hierarchy(old.frame);
  }
});

test('Documented native axis properties restore only the actual approved Hug Frame when its shorthand is rejected', async () => {
  const faults = { rejectSizingAxis: (node, axis) => isTax(node) && axis === 'Vertical' };
  const doc = structuredClone(original.doc); doc.options.debug = true;
  const result = await convert(doc, faults); evidence.faults.shorthandRejected = editCheck(result);
  assert.match(JSON.parse(targets(result.frame)['Tax Section'].getPluginData('html-height-sizing')).reason, /final Height Hug restored/);
  assert.equal(targets(result.frame)['Tax Section'].layoutSizingHorizontal, 'FILL');
});

test('A runtime rejecting both Height setters is reported as an actual Fixed failure, retaining all descendants', async () => {
  const faults = { rejectSizingAxis: (node, axis) => isTax(node) && axis === 'Vertical',
    rejectLegacySizing: (node, axis, value) => isTax(node) && axis === 'Primary' && value === 'AUTO' };
  const doc = structuredClone(original.doc); doc.options.debug = true;
  const result = await convert(doc, faults), t = targets(result.frame);
  const entry = result.report.heightHierarchy.find(entry => entry.id === t['Tax Section'].id);
  assert.equal(entry.requestedHeightMode, 'HUG'); assert.equal(entry.heightMode, 'FIXED');
  assert.match(entry.reason, /Final height is FIXED, requested Hug/);
  assert.ok(result.report.warnings.some(w => w.code === 'HEIGHT_LAYOUT' && w.message.includes(t['Tax Section'].id)));
  assert.equal(t['Card List'].children.length, 6); assert.equal(t['Card List'].layoutSizingVertical, 'HUG');
  evidence.faults.unsupportedHeightAPI = hierarchy(result.frame);
});

function unchanged(node) {
  return { name: node.name, type: node.type, width: node.width, horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical,
    layout: node.layoutMode, wrap: node.layoutWrap, height: node.height, y: node.parent?.type === 'PAGE' ? 0 : node.y, positioning: node.layoutPositioning,
    padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft], minHeight: node.minHeight, maxHeight: node.maxHeight,
    fills: node.fills, strokes: node.strokes, effects: node.effects, opacity: node.opacity, characters: node.characters, font: node.fontName,
    fontSize: node.fontSize, resize: node.textAutoResize, ranges: node.rangeStyles, children: node.children.map(unchanged) };
}
test('Normal-runtime actual HTML output, names, widths, wrappers and styles match c682e41; protected modules are byte-identical', { skip: !baseline }, async () => {
  for (const file of ['layer-naming.ts', 'rich-text.ts', 'inline-layout.ts', 'sizing.ts', 'grid.ts', 'svg.ts', 'gradients.ts', 'backgrounds.ts', 'form-controls.ts', 'optimizer.ts'])
    assert.equal(await readFile(`src/${file}`, 'utf8'), await readFile(resolve(baseline, file), 'utf8'), `${file} unchanged`);
  const previous = await convert(original.doc, {}, oldConverter), current = await convert();
  assert.deepEqual(unchanged(current.frame), unchanged(previous.frame)); assert.deepEqual(current.svgImports, previous.svgImports);
  evidence.baseline = { commit: 'c682e41', normalRuntimeOutputEqual: true, nodes: flatten(current.frame).length };
  assert.equal(current.report.heightHierarchy, undefined, 'No debug payload outside Debug Mode');
});

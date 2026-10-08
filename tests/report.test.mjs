import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createFigmaMock } from './figma-mock.mjs';

let reports, browser, server, url, parser, oldParser, converter, oldConverter;
const baseline = process.env.REPORT_BASELINE_SRC;
// Keep the report-stage proof reproducible after intentional layout changes in later stages.
const implementation = process.env.REPORT_IMPLEMENTATION_SRC || 'src';
const bundle = async entry => (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'Parser' })).outputFiles[0].text;
before(async () => {
  await mkdir('test-results', { recursive: true });
  await build({ entryPoints: ['src/report.ts'], bundle: true, outfile: 'test-results/report-utils.mjs', format: 'esm', platform: 'node' });
  reports = await import('../test-results/report-utils.mjs');
  if (!baseline) return;
  parser = await bundle(resolve(implementation, 'parser.ts')); oldParser = await bundle(resolve(baseline, 'parser.ts'));
  for (const [entry, output] of [[resolve(implementation, 'converter.ts'), 'report-converter'], [resolve(baseline, 'converter.ts'), 'report-old-converter']])
    await build({ entryPoints: [entry], bundle: true, outfile: `test-results/${output}.mjs`, format: 'esm', platform: 'node' });
  converter = await import('../test-results/report-converter.mjs'); oldConverter = await import('../test-results/report-old-converter.mjs');
  server = createServer((_req, res) => res.end('<!doctype html><div id="host"></div>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH || await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined);
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

test('Report preserves every raw diagnostic and excludes normal mappings and Debug from warning totals', () => {
  const raw = ['ABSOLUTE_ELEMENT', 'FIXED_ELEMENT', 'FIXED_POSITION', 'BACKGROUND_DEBUG', 'HEIGHT_HIERARCHY', 'HEIGHT_SIZING', 'ACCESSIBILITY_HIDDEN', 'DISPLAY_CONTENTS'].map(code => ({ code, node: 'node', message: 'Info' }));
  const report = { warnings: raw }, before = structuredClone(raw);
  const outcome = reports.conversionOutcome(report, 'ok.html');
  assert.equal(outcome.status, 'SUCCESS'); assert.equal(outcome.warningCount, 0); assert.deepEqual(raw, before);
  for (const [code, expected] of [['FONT_REPLACED', 'FONT_FALLBACK'], ['SVG_IMPORT', 'SVG_ERROR'], ['IMAGE_LOAD', 'IMAGE_ERROR'], ['SIZING_API', 'SIZING_FALLBACK'], ['RELATIVE_ASSET', 'EXTERNAL_RESOURCE'], ['UNSUPPORTED_CSS', 'UNSUPPORTED_STYLE'], ['NODE_FAILED', 'CONVERSION_WARNING']])
    assert.equal(reports.reportCode({ code }), expected);
  assert.equal(reports.reportCode({ code: 'UNSUPPORTED_CSS' }, { styles: false }), null);
  assert.equal(reports.reportCode({ code: 'IMAGE_SOURCE' }, { images: false }), null);
});

test('Repeated diagnostics retain counts and bounded locations, and distinct causes never collapse', () => {
  const raw = [], warn = reports.warningCollector(raw, 2);
  for (let i = 0; i < 100; i++) warn('FONT_REPLACED', 'p', 'Missing → Inter', { element: `p#${i}`, detail: { originalFont: 'Missing', fallbackFont: 'Inter' } });
  warn('FONT_REPLACED', 'p', 'Other → Inter', { element: 'p#other', detail: { originalFont: 'Other', fallbackFont: 'Inter' } });
  const groups = reports.groupReportWarnings(raw);
  assert.equal(raw.length, 2); assert.equal(groups.length, 2); assert.equal(groups[0].count, 100);
  assert.equal(groups[0].locations.length, 5); assert.deepEqual(groups[0].locations, ['p#0', 'p#1', 'p#2', 'p#3', 'p#4']);
  const long = 'x'.repeat(500);
  assert.equal(reports.groupReportWarnings(['first', 'second'].map(tail => ({ code: 'IMAGE_LOAD', node: 'img', message: long + tail }))).length, 2, 'Preview truncation must not hide distinct causes');
  const error = reports.failedOutcome('bad.html', 'Root failed\n at internal (code.js:10)');
  assert.equal(error.status, 'ERROR'); assert.equal(error.result.frameCreated, false); assert.equal(error.errorMessage, 'Root failed');
});

test('Duplicate internal names do not attach an arbitrary HTML selector to warnings', () => {
  const root = { name: 'root', children: [{ name: 'same', source: { selector: 'section.first' }, children: [] }, { name: 'same', source: { selector: 'div.second' }, children: [] }] };
  const warnings = [{ code: 'NODE_FAILED', node: 'same', message: 'Failed' }];
  reports.enrichWarnings(warnings, root); assert.equal(warnings[0].element, 'same');
});

async function parse(html, script) {
  const page = await browser.newPage();
  try {
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.goto(url); await page.addScriptTag({ content: script });
    return JSON.parse(await page.evaluate(async html => JSON.stringify(await Parser.parseHTML(html, { viewport: 1920, viewportHeight: 900, autoLayout: true, styles: true }, document.getElementById('host'))), html));
  } finally { await page.close(); }
}
function snapshot(node) {
  return { type: node.type, name: node.name, width: node.width, height: node.height, x: node.x, y: node.y,
    horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical, primary: node.primaryAxisSizingMode, counter: node.counterAxisSizingMode,
    layout: node.layoutMode, wrap: node.layoutWrap, gap: node.itemSpacing, rowGap: node.counterAxisSpacing, positioning: node.layoutPositioning,
    padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft], minWidth: node.minWidth, maxWidth: node.maxWidth, minHeight: node.minHeight, maxHeight: node.maxHeight,
    radius: [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius], fills: node.fills, strokes: node.strokes, effects: node.effects, opacity: node.opacity, clips: node.clipsContent,
    text: node.characters, font: node.fontName, fontSize: node.fontSize, resize: node.textAutoResize, ranges: node.rangeStyles, children: node.children.map(snapshot) };
}
test('Report-only changes leave complete IR and Figma layout/style/text/naming/assets identical to be2d331', { skip: !baseline }, async () => {
  for (const file of ['layer-naming.ts', 'rich-text.ts', 'inline-layout.ts', 'sizing.ts', 'height-sizing.ts', 'grid.ts', 'svg.ts', 'gradients.ts', 'backgrounds.ts', 'form-controls.ts', 'optimizer.ts'])
    assert.equal(await readFile(resolve(implementation, file), 'utf8'), await readFile(resolve(baseline, file), 'utf8'), `${file} unchanged during Report stage`);
  assert.equal(await readFile('src/report.ts', 'utf8'), await readFile(resolve(implementation, 'report.ts'), 'utf8'), 'Current report policy retains the report-stage implementation');
  const evidence = [];
  for (const file of ['test/actual/09-01_A-pc-list.html', 'examples/mvp.html', 'test/dashboard-rendering-regression.html', 'test/form-controls-regression.html', 'test/fixed-position-regression.html', 'test/phase2-test.html', 'test/rendering-regression.html', 'test/gradient-regression.html', 'test/inline-accessibility-regression.html', 'test/layer-naming-regression.html', 'test/rich-text-regression.html', 'test/nested-hug-regression.html']) {
    const html = await readFile(file, 'utf8'), before = await parse(html, oldParser), current = await parse(html, parser);
    const withoutDiagnostics = doc => ({ ...doc, warnings: [] });
    assert.deepEqual(withoutDiagnostics(current), withoutDiagnostics(before), `${file}: entire conversion data excluding warnings`);
    const priorMock = createFigmaMock(); globalThis.figma = priorMock.figma; const prior = await oldConverter.convertDocument(before);
    const mock = createFigmaMock(); globalThis.figma = mock.figma; const result = await converter.convertDocument(current);
    assert.deepEqual(snapshot(result.frame), snapshot(prior.frame), `${file}: entire final node tree`);
    assert.deepEqual(mock.svgImports, priorMock.svgImports); assert.deepEqual(mock.images, priorMock.images);
    for (const key of ['total', 'autoLayout', 'text', 'image', 'frames', 'grid', 'absolute', 'svg']) assert.equal(result.report[key], prior.report[key]);
    evidence.push({ file, nodes: result.report.total, entireIREqual: true, entireFigmaTreeEqual: true, assetBytesEqual: true });
  }
  await writeFile('test-results/report-regression.json', JSON.stringify({ baseline: 'be2d331', evidence }, null, 2));
});

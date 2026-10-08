import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createFigmaMock, flatten } from './figma-mock.mjs';
import { restoreAtomicComponentPolicy, restoreAtomicTextResize } from './component-compat.mjs';

let browser, server, url, parser, converter, oldParser, oldConverter;
const baseline = process.env.NESTED_BASELINE_SRC;
const bundle = async entry => (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'Parser', target: 'es2020' })).outputFiles[0].text;
before(async () => {
  await mkdir('test-results', { recursive: true }); parser = await bundle('src/parser.ts');
  await build({ entryPoints: ['src/converter.ts'], bundle: true, outfile: 'test-results/nested-converter.mjs', format: 'esm', platform: 'node' });
  converter = await import('../test-results/nested-converter.mjs');
  if (baseline) {
    oldParser = await bundle(resolve(baseline, 'parser.ts'));
    await build({ entryPoints: [resolve(baseline, 'converter.ts')], bundle: true, outfile: 'test-results/nested-baseline-converter.mjs', format: 'esm', platform: 'node' });
    oldConverter = await import('../test-results/nested-baseline-converter.mjs');
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
const fixture = () => readFile('test/nested-hug-regression.html', 'utf8');
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1, `${label}: ${a} vs ${b}`);

function apiTree(node) {
  return { key: node.originalName || node.name, type: node.type, x: node.x, y: node.y, width: node.width, height: node.height,
    layout: node.layoutMode, horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical, positioning: node.layoutPositioning,
    wrap: node.layoutWrap, gap: node.itemSpacing || 0, rowGap: node.counterAxisSpacing || 0, align: node.counterAxisAlignItems, justify: node.primaryAxisAlignItems,
    padding: [node.paddingTop || 0, node.paddingRight || 0, node.paddingBottom || 0, node.paddingLeft || 0],
    minHeight: node.minHeight, maxHeight: node.maxHeight, minWidth: node.minWidth, maxWidth: node.maxWidth,
    characters: node.characters, font: node.fontName, fontSize: node.fontSize, lineHeight: node.lineHeight, resize: node.textAutoResize,
    children: node.children.map(apiTree) };
}
async function project(tree, mutation = '') {
  // Independent browser projection of final Plugin API properties. This is not Figma's engine.
  const page = await browser.newPage();
  try {
    await page.goto(url);
    return await page.evaluate(({ tree, mutation }) => {
      document.body.style.margin = '0';
      function add(node, parent, parentNode) {
        const el = document.createElement('div'); el.dataset.key = node.key;
        const autoParent = parentNode && parentNode.layout !== 'NONE' && node.positioning !== 'ABSOLUTE';
        const style = { boxSizing: 'border-box', position: autoParent || !parentNode ? 'relative' : 'absolute',
          width: node.horizontal === 'HUG' ? 'max-content' : `${node.width}px`, height: node.vertical === 'HUG' ? 'auto' : `${node.height}px`,
          minHeight: node.minHeight ? `${node.minHeight}px` : '0', maxHeight: node.maxHeight ? `${node.maxHeight}px` : 'none', flex: 'none' };
        if (!autoParent && parentNode) Object.assign(style, { left: `${node.x}px`, top: `${node.y}px` });
        if (autoParent && node.horizontal === 'FILL') {
          if (parentNode.layout === 'VERTICAL') Object.assign(style, { alignSelf: 'stretch', width: 'auto' });
          else Object.assign(style, { flex: '1 1 0px', width: '0', minWidth: '0' });
        }
        if (autoParent && node.vertical === 'FILL') {
          if (parentNode.layout === 'VERTICAL') Object.assign(style, { flex: '1 1 0px', height: '0' });
          else Object.assign(style, { alignSelf: 'stretch', height: 'auto' });
        }
        if (node.layout !== 'NONE') Object.assign(style, { display: 'flex', flexDirection: node.layout === 'VERTICAL' ? 'column' : 'row',
          flexWrap: node.wrap === 'WRAP' ? 'wrap' : 'nowrap', columnGap: `${node.gap}px`, rowGap: `${node.wrap === 'WRAP' ? node.rowGap : node.gap}px`,
          alignItems: ({ MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' })[node.align] || 'flex-start',
          justifyContent: ({ MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' })[node.justify] || 'flex-start',
          alignContent: 'flex-start', padding: node.padding.map(v => `${v}px`).join(' ') });
        if (node.type === 'TEXT') {
          Object.assign(style, { fontFamily: `${node.font?.family || 'Inter'}, sans-serif`, fontSize: `${node.fontSize}px`,
            fontWeight: node.font?.style === 'Bold' ? '700' : '400', lineHeight: node.lineHeight?.unit === 'PIXELS' ? `${node.lineHeight.value}px` : 'normal',
            whiteSpace: node.resize === 'WIDTH_AND_HEIGHT' ? 'pre' : 'pre-wrap' });
          el.textContent = node.characters;
        }
        Object.assign(el.style, style); parent.append(el); node.children.forEach(child => add(child, el, node)); return el;
      }
      const root = add(tree, document.body);
      const list = root.querySelector('[data-key="card-list"]');
      if (mutation === 'add' || mutation === 'delete') { const copy = list.firstElementChild.cloneNode(true); copy.dataset.key = 'card-7'; list.append(copy); if (mutation === 'delete') copy.remove(); }
      if (mutation === 'long-text') list.firstElementChild.lastElementChild.textContent = '긴 상담 내용이 여러 줄로 표시되어 카드와 상위 영역이 함께 늘어납니다. '.repeat(28);
      if (typeof mutation === 'object') [...root.querySelectorAll('[data-key]')].find(el => el.dataset.key === mutation.key).textContent = mutation.text;
      const rootRect = root.getBoundingClientRect();
      return Object.fromEntries([root, ...root.querySelectorAll('[data-key]')].map(el => {
        const r = el.getBoundingClientRect(); return [el.dataset.key, { x: r.x - rootRect.x, y: r.y - rootRect.y, width: r.width, height: r.height }];
      }));
    }, { tree, mutation });
  } finally { await page.close(); }
}
async function browserSource(html, mutation) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(html);
    return await page.evaluate(mutation => {
      if (mutation === 'add') { const list = document.getElementById('card-list'); const copy = list.firstElementChild.cloneNode(true); copy.id = 'card-7'; list.append(copy); }
      if (mutation === 'long-text') document.querySelector('#card-1 p').textContent = '긴 상담 내용이 여러 줄로 표시되어 카드와 상위 영역이 함께 늘어납니다. '.repeat(28);
      const rects = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => { const r = el.getBoundingClientRect(); return [el.id, { x: r.x, y: r.y, width: r.width, height: r.height }]; }));
      rects['Imported HTML'] = rects.page; return rects;
    }, mutation);
  } finally { await page.close(); }
}
function hierarchy(frame) {
  return ['Imported HTML', 'tax-section', 'tax-inner', 'card-list', 'card-1', 'next-section'].map(name => {
    const node = find(frame, name); return { node: name, parent: node.parent?.originalName, layout: node.layoutMode, heightMode: node.layoutSizingVertical,
      height: node.height, minHeight: node.minHeight, positioning: node.layoutPositioning, children: node.children.map(child => child.originalName) };
  });
}

test('Nested block ancestors propagate 6 → 7 → 6 wrapped cards through Section and normal-flow sibling, preserving root min-height', async () => {
  const html = await fixture(), doc = await parse(html), result = await convert(doc, { simulateAutoHeight: true, resizeResetsHug: true });
  const initial = await project(apiTree(result.frame)), added = await project(apiTree(result.frame), 'add'), restored = await project(apiTree(result.frame), 'delete');
  const evidence = { originalHTMLAvailable: false, verification: 'Plugin API double + independent Chromium projection; actual Figma editing remains manual', after: hierarchy(result.frame), initial, added, restored };
  if (baseline) {
    const oldDoc = await parse(html, {}, oldParser), old = await convert(oldDoc, { simulateAutoHeight: true }, oldConverter);
    evidence.before = hierarchy(old.frame); evidence.beforeInitial = await project(apiTree(old.frame)); evidence.beforeAdded = await project(apiTree(old.frame), 'add');
  }
  await writeFile('test-results/nested-hug.json', JSON.stringify(evidence, null, 2));
  assert.equal(find(result.frame, 'card-list').layoutWrap, 'WRAP');
  for (const name of ['tax-section', 'tax-inner', 'card-list', 'card-1']) assert.equal(find(result.frame, name).layoutSizingVertical, 'HUG', name);
  for (const name of ['tax-section', 'tax-inner']) assert.equal(find(result.frame, name).layoutMode, 'VERTICAL', name);
  assert.equal(result.frame.layoutMode, 'VERTICAL'); assert.equal(result.frame.minHeight, 4463);
  assert.equal(find(result.frame, 'next-section').layoutPositioning, 'AUTO');
  assert.equal(find(result.frame, 'next-section').layoutSizingVertical, 'HUG');
  assert.equal(find(result.frame, 'card-1').minHeight, 340);
  near(initial['card-list'].height, 700, 'six cards'); near(added['card-list'].height, 1060, 'seven cards');
  near(added['tax-section'].height - initial['tax-section'].height, 360, 'Section expands');
  near(added['next-section'].y - initial['next-section'].y, 360, 'sibling moves');
  assert.ok(added['next-section'].y >= added['tax-section'].y + added['tax-section'].height);
  assert.deepEqual(restored, initial, 'deleting the clone restores all positions');
  for (const name of ['tax-section', 'tax-inner', 'card-list', 'next-section']) {
    const original = source(doc, name); near(initial[name].height, original.rect.height, `${name} initial height`);
    near(initial[name].x, original.rect.x - doc.root.rect.x, `${name} initial x`); near(initial[name].y, original.rect.y - doc.root.rect.y, `${name} initial y`);
  }
  const list = find(result.frame, 'card-list'), copy = { ...list.children[0], parent: undefined, children: [...list.children[0].children] };
  list.appendChild(copy); assert.equal(list.height, 1060); assert.equal(find(result.frame, 'tax-section').height, initial['tax-section'].height + 360);
  assert.equal(result.frame.height, 4823); list.children = list.children.filter(child => child !== copy); assert.equal(result.frame.height, 4463);
  if (baseline) {
    near(evidence.beforeAdded['card-list'].height, 1060, 'old list already grows');
    assert.equal(evidence.beforeAdded['tax-section'].height, evidence.beforeInitial['tax-section'].height);
    assert.equal(evidence.beforeAdded['next-section'].y, evidence.beforeInitial['next-section'].y);
  }
});

test('Long Text grows a Hug + min-height Card, Wrap row, all ancestors and the following Section', async () => {
  const doc = await parse(await fixture()), result = await convert(doc, { simulateAutoHeight: true });
  const initial = await project(apiTree(result.frame)), changed = await project(apiTree(result.frame), 'long-text');
  assert.ok(changed['card-1'].height > 340, 'Text exceeds minimum Card height');
  const delta = changed['card-1'].height - initial['card-1'].height;
  for (const name of ['card-list', 'tax-inner', 'tax-section', 'Imported HTML']) near(changed[name].height - initial[name].height, delta, `${name} grows with text`);
  near(changed['next-section'].y - initial['next-section'].y, delta, 'next Section follows text growth');
  assert.ok(changed['next-section'].y >= changed['tax-section'].y + changed['tax-section'].height);
  for (const name of ['tax-section', 'tax-inner', 'card-list', 'card-1']) assert.equal(find(result.frame, name).layoutSizingVertical, 'HUG');
  assert.equal(find(result.frame, 'card-1').minHeight, 340);
  await writeFile('test-results/nested-text-growth.json', JSON.stringify({ verification: 'Chromium projection of Plugin API properties, not actual Figma font metrics', initial, changed }, null, 2));
});

test('Projected initial/add/Text edits match the original reproduction CSS in an independent browser', async () => {
  const html = await fixture(), result = await convert(await parse(html));
  for (const mutation of ['', 'add', 'long-text']) {
    const projected = await project(apiTree(result.frame), mutation), original = await browserSource(html, mutation);
    for (const name of ['Imported HTML', 'tax-section', 'tax-inner', 'card-list', 'card-1', 'next-section']) {
      near(projected[name].height, original[name].height, `${name} ${mutation}: source height`);
      near(projected[name].y, original[name].y, `${name} ${mutation}: source y`);
    }
  }
});

test('The existing Card List Fill Width and an existing margin wrapper both survive ancestor Hug promotion', async () => {
  const variants = [
    (await fixture()).replace('#tax-inner {', '#tax-inner { display:flex; flex-direction:column; gap:32px;').replace('margin: 0 0 32px;', 'margin: 0;'),
    (await fixture()).replace('#tax-section {', '#tax-section { display:flex; flex-direction:column;'),
  ];
  for (const [index, html] of variants.entries()) {
    const doc = await parse(html), result = await convert(doc, { simulateAutoHeight: true });
    if (index === 0) { assert.equal(source(doc, 'card-list').size.widthMode, 'FILL'); assert.equal(find(result.frame, 'card-list').layoutSizingHorizontal, 'FILL'); }
    else { const wrapper = find(result.frame, 'tax-inner').parent; assert.ok(wrapper.originalName.endsWith(' / margin')); assert.equal(wrapper.layoutSizingVertical, 'HUG'); }
    const initial = await project(apiTree(result.frame)), added = await project(apiTree(result.frame), 'add');
    near(initial['card-list'].height, 700, 'initial list'); near(added['card-list'].height, 1060, 'new row');
    near(added['tax-section'].height - initial['tax-section'].height, 360, 'ancestor expands');
    near(added['next-section'].y - initial['next-section'].y, 360, 'next section moves');
    if (baseline) {
      const old = await convert(await parse(html, {}, oldParser), {}, oldConverter);
      assert.deepEqual(unchangedVisuals(result.frame), unchangedVisuals(old.frame), 'width, naming, and existing margin wrappers stay unchanged');
    }
  }
});

const documentFor = content => `<style>*{box-sizing:border-box}body{margin:0;font:16px/24px Inter,sans-serif}main{display:flex;flex-direction:column}h2,p{margin:0}</style><main>${content}</main>`;
test('Measured collapsed block margins and edge padding preserve initial boxes and wrapper structure', async () => {
  for (const content of [
    '<section id="flow" style="padding:12px 8px"><p id="first" style="margin:10px 0 20px">First</p><p id="second" style="margin:12px 0 6px">Second</p></section>',
    '<section id="flow" style="padding:12px 8px;min-height:160px"><p id="first">First</p><div id="second" style="display:flex;flex-direction:column;height:auto"><p>Second</p></div></section>',
    '<section id="flow" style="padding:12px 8px"><div id="first" style="width:200px;height:24px;margin:0 auto 20px"></div><div id="second" style="width:160px;height:24px;margin:0 auto"></div></section>',
  ]) {
    const doc = await parse(documentFor(content)), result = await convert(doc, { simulateAutoHeight: true }), node = find(result.frame, 'flow');
    assert.equal(node.layoutMode, 'VERTICAL'); assert.equal(node.layoutSizingVertical, 'HUG');
    assert.equal(node.children.length, source(doc, 'flow').children.length, 'no new margin or row wrappers');
    near(node.height, source(doc, 'flow').rect.height, 'initial height');
    const geometry = await project(apiTree(result.frame));
    near(geometry.flow.height, source(doc, 'flow').rect.height, 'independent layout height');
    const expectedChildren = source(doc, 'flow').children;
    for (const [index, child] of node.children.entries()) {
      near(child.width, expectedChildren[index].size.width, 'width unchanged');
      near(geometry[child.originalName].x, expectedChildren[index].rect.x - doc.root.rect.x, 'x unchanged');
      near(geometry[child.originalName].y, expectedChildren[index].rect.y - doc.root.rect.y, 'y unchanged');
    }
  }
});

test('Detail FAQ/Aside and Mobile sections support text growth while explicit 300px Hero stays Fixed', async () => {
  const contentText = '상담 답변을 읽고 다음 내용을 확인하세요. '.repeat(8), longText = contentText.repeat(8);
  const cases = [
    { viewport: 1440, viewportHeight: 900, html: documentFor(`<div id="detail-row" style="display:flex;gap:24px;align-items:flex-start"><aside id="ai-aside" style="width:280px;display:flex;flex-direction:column;gap:12px"><h2>AI 상담</h2><p>질문을 입력하세요</p></aside><section id="detail-content" style="flex:1;padding:32px"><h2 style="margin-bottom:20px">상세 콘텐츠</h2><section id="faq" style="padding:24px"><h2 style="margin-bottom:16px">FAQ</h2><p id="answer" style="width:100%">${contentText}</p></section></section></div><section id="following" style="height:80px"></section>`), chain: ['faq', 'detail-content', 'detail-row'] },
    { viewport: 375, viewportHeight: 812, html: documentFor(`<div id="hero" style="height:300px"></div><section id="mobile-content" style="padding:16px"><h2 style="margin-bottom:16px">모바일 상담</h2><p id="answer" style="width:100%">${contentText}</p></section><section id="following" style="height:80px"></section>`), chain: ['mobile-content'] },
  ];
  for (const item of cases) {
    const doc = await parse(item.html, { viewport: item.viewport, viewportHeight: item.viewportHeight }), result = await convert(doc);
    const initial = await project(apiTree(result.frame)), changed = await project(apiTree(result.frame), { key: 'answer', text: longText });
    const delta = changed.answer.height - initial.answer.height; assert.ok(delta > 0);
    for (const name of item.chain) { assert.equal(find(result.frame, name).layoutSizingVertical, 'HUG', name); near(changed[name].height - initial[name].height, delta, `${name} propagates FAQ text`); }
    near(changed.following.y - initial.following.y, delta, 'following section moves');
    if (item.viewport === 375) { assert.equal(find(result.frame, 'hero').layoutSizingVertical, 'FIXED'); assert.equal(changed.hero.height, 300); }
    else { assert.equal(find(result.frame, 'ai-aside').layoutSizingVertical, 'HUG'); assert.equal(find(result.frame, 'ai-aside').width, 280); assert.deepEqual(changed['ai-aside'], initial['ai-aside']); }
  }
});

test('Fixed Action Bar stays viewport anchored when the normal document and Sections grow', async () => {
  const html = (await fixture()).replace('</main>', '<div id="action-bar" style="position:fixed;left:240px;right:0;bottom:0;height:76px;display:flex;background:white"><span>저장</span></div></main>');
  const doc = await parse(html), result = await convert(doc), target = find(result.frame, 'action-bar');
  const initial = await project(apiTree(result.frame)), added = await project(apiTree(result.frame), 'add');
  assert.equal(target.parent, result.frame); assert.equal(target.layoutPositioning, 'ABSOLUTE');
  assert.deepEqual([target.x, target.y, target.width, target.height], [240, 824, 1200, 76]);
  assert.deepEqual(added['action-bar'], initial['action-bar']);
  near(added['next-section'].y - initial['next-section'].y, 360, 'normal flow moves independently of fixed Bar');
});

test('Root minimum is retained as a lower bound; explicit Root height stays Fixed while normal children still reflow', async () => {
  for (const [css, mode, height] of [['min-height: 6000px', 'HUG', 6000], ['height: 4463px', 'FIXED', 4463]]) {
    const html = (await fixture()).replace('min-height: 4463px', css), result = await convert(await parse(html), { simulateAutoHeight: true, resizeResetsHug: true });
    assert.equal(result.frame.layoutSizingVertical, mode);
    const initial = await project(apiTree(result.frame)), added = await project(apiTree(result.frame), 'add');
    assert.equal(initial['Imported HTML'].height, height); assert.equal(added['Imported HTML'].height, height);
    near(added['next-section'].y - initial['next-section'].y, 360, 'normal children reflow inside constrained Root');
    if (mode === 'HUG') assert.equal(result.frame.minHeight, 6000);
  }
});

test('Viewport override cannot change newly promoted centered block positions or the Width policy', async () => {
  const html = (await fixture()).replace('min-height: 4463px;', 'min-height: 4463px; width:1440px;');
  const doc = await parse(html, { viewport: 1600 }), result = await convert(doc);
  assert.equal(find(result.frame, 'tax-section').layoutMode, 'NONE');
  assert.match(source(doc, 'tax-section').size.heightSource.reason, /Viewport width changes block alignment/);
  const projected = await project(apiTree(result.frame));
  near(projected['tax-inner'].x, source(doc, 'tax-inner').rect.x, 'centered block retains measured x');
  assert.equal(result.frame.width, 1600);
  assert.ok(result.report.warnings.some(warning => warning.code === 'HEIGHT_LAYOUT'));
});

test('Unsafe block flows keep source coordinates: unequal gaps, inline content, relative shifts, transforms, negative margins and hidden margin collapse', async () => {
  for (const content of [
    '<section id="unsafe" style="padding:12px"><div style="height:24px;margin-bottom:10px"></div><div style="height:24px;margin-bottom:30px"></div><div style="height:24px"></div></section>',
    '<section id="unsafe"><strong>Inline</strong><span>Badge</span><div style="height:24px"></div></section>',
    '<section id="unsafe"><div style="height:24px;position:relative;top:12px"></div><div style="height:24px;margin-top:12px"></div></section>',
    '<section id="unsafe" style="padding:12px"><div style="height:24px;transform:translateY(4px)"></div><div style="height:24px;margin-top:4px"></div></section>',
    '<section id="unsafe" style="padding:12px"><div style="height:24px;margin-bottom:-4px"></div><div style="height:24px"></div></section>',
    '<section id="unsafe" style="padding:12px;min-height:160px"><p style="margin-bottom:12px">Ambiguous bottom margin</p></section>',
  ]) {
    const doc = await parse(documentFor(content)), result = await convert(doc), node = find(result.frame, 'unsafe'), parsed = source(doc, 'unsafe');
    assert.equal(node.layoutMode, 'NONE'); assert.equal(node.layoutSizingVertical, 'FIXED');
    assert.equal(node.height, parsed.size.height); assert.equal(node.children.length, parsed.children.length);
    for (const [index, child] of node.children.entries()) { near(child.x, parsed.children[index].rect.x - parsed.rect.x, 'source x'); near(child.y, parsed.children[index].rect.y - parsed.rect.y, 'source y'); }
    assert.ok(!result.report.warnings.some(warning => warning.code === 'NODE_FAILED'));
  }
});

test('flex:none and min-height differ from explicit Height; disabled Auto Layout and true Fill dependencies keep their policy', async () => {
  const content = '<section id="auto" style="flex:none;padding:12px"><p style="margin-bottom:10px">First</p><p>Second</p></section><section id="fixed" style="height:160px;padding:12px"><p>First</p></section><section id="fill-parent" style="display:flex;flex-direction:column;height:200px"><div id="fill" style="flex:1;display:flex;flex-direction:column"><p>Fill</p></div></section>';
  const doc = await parse(documentFor(content)), result = await convert(doc, { simulateAutoHeight: true, resizeResetsHug: true });
  assert.equal(find(result.frame, 'auto').layoutSizingVertical, 'HUG'); assert.equal(source(doc, 'auto').layout.grow, 0); assert.equal(source(doc, 'auto').layout.shrink, 0);
  assert.equal(find(result.frame, 'fixed').layoutSizingVertical, 'FIXED'); assert.equal(find(result.frame, 'fixed').height, 160);
  assert.equal(find(result.frame, 'fill').layoutSizingVertical, 'FILL');
  const off = await convert(await parse(documentFor(content), { autoLayout: false }));
  assert.equal(find(off.frame, 'auto').layoutMode, 'NONE'); assert.equal(find(off.frame, 'auto').layoutSizingVertical, 'FIXED');
  const cyclic = await convert(await parse(documentFor('<section id="cycle" style="display:flex;flex-direction:column"><div style="flex:1;display:flex;flex-direction:column"><p>Grow</p></div></section>')));
  assert.equal(find(cyclic.frame, 'cycle').layoutSizingVertical, 'FIXED'); assert.ok(cyclic.report.warnings.some(warning => warning.code === 'SIZING_CYCLE'));
});

test('Normal-flow metadata is validated before allocation; Debug explains each ancestor decision', async () => {
  const doc = await parse(await fixture(), { debug: true }), result = await convert(doc);
  for (const name of ['tax-section', 'tax-inner']) {
    const node = flatten(result.frame).find(node => node.getPluginData('html-source') === source(doc, name).source.selector);
    const details = JSON.parse(node.getPluginData('html-height-sizing')); assert.equal(details.mode, 'HUG'); assert.match(details.reason, /ancestor height propagation/);
    assert.ok(result.report.warnings.some(warning => warning.node === name && /ancestor height propagation/.test(warning.message)));
  }
  for (const mutate of [flow => { flow.gap = -1; }, flow => { flow.padding = {}; }, flow => { flow.align = 'BASELINE'; }]) {
    const bad = structuredClone(doc); mutate(source(bad, 'tax-inner').layout.normalFlow);
    const mock = createFigmaMock(); globalThis.figma = mock.figma;
    await assert.rejects(() => converter.convertDocument(bad), /Normal Flow/); assert.equal(mock.figma.currentPage.children.length, 0);
  }
});

function allowedHeightChange(current, previous) {
  const copy = restoreAtomicComponentPolicy(current, previous);
  function visit(node, old) {
    assert.equal(node.children.length, old.children.length, `${node.name}: parsed wrappers/children changed`);
    if (node.layout.normalFlow || node.size.heightSource?.reason === 'Viewport width changes block alignment; measured geometry retained') {
      node.layout.direction = old.layout.direction; node.size.heightMode = old.size.heightMode;
      node.size.heightSource.reason = old.size.heightSource.reason; delete node.layout.normalFlow;
    }
    // Fallback explanations are diagnostic text; geometry/sizing decisions remain compared in full.
    if (node.size.heightSource && old.size.heightSource) {
      if ('reason' in old.size.heightSource) node.size.heightSource.reason = old.size.heightSource.reason;
      else delete node.size.heightSource.reason;
    }
    node.children.forEach((child, index) => visit(child, old.children[index]));
  }
  visit(copy.root, previous.root);
  copy.warnings = copy.warnings.filter(warning => !['HEIGHT_LAYOUT', 'WEB_FONT_LOAD'].includes(warning.code)).map(({ code, node, message }) => ({ code, node, message }));
  return copy;
}
function unchangedVisuals(node) {
  return { name: node.name, type: node.type, width: node.width, fills: node.fills, strokes: node.strokes, effects: node.effects, opacity: node.opacity, clips: node.clipsContent,
    characters: node.characters, font: node.fontName, fontSize: node.fontSize, resize: node.textAutoResize, ranges: node.rangeStyles,
    children: node.children.map(unchangedVisuals) };
}
test('Compared with d56ef4a, width/names/wrappers/Rich Text/SVG/Gradient/Form/Grid modules and final paints remain unchanged', { skip: !baseline }, async () => {
  for (const file of ['layer-naming.ts', 'rich-text.ts', 'inline-layout.ts', 'sizing.ts', 'grid.ts', 'svg.ts', 'gradients.ts', 'backgrounds.ts', 'form-controls.ts', 'optimizer.ts'])
    assert.equal(await readFile(`src/${file}`, 'utf8'), await readFile(resolve(baseline, file), 'utf8'), `${file} unchanged`);
  const results = [];
  for (const file of ['examples/mvp.html', 'test/dashboard-rendering-regression.html', 'test/form-controls-regression.html', 'test/fixed-position-regression.html',
    'test/phase2-test.html', 'test/rendering-regression.html', 'test/gradient-regression.html', 'test/inline-accessibility-regression.html', 'test/layer-naming-regression.html',
    'test/rich-text-regression.html', 'test/height-sizing-regression.html', 'test/nested-hug-regression.html']) {
    const html = await readFile(file, 'utf8'), oldDoc = await parse(html, {}, oldParser), doc = await parse(html);
    assert.deepEqual(allowedHeightChange(doc, oldDoc), oldDoc, `${file}: only verified block height flow may change`);
    const previous = await convert(oldDoc, {}, oldConverter), current = await convert(doc);
    assert.deepEqual(restoreAtomicTextResize(unchangedVisuals(current.frame), unchangedVisuals(previous.frame), doc), unchangedVisuals(previous.frame), `${file}: final width/names/wrappers/text/paints outside atomic Text auto width changed`);
    assert.deepEqual(current.svgImports, previous.svgImports); assert.deepEqual(current.images, previous.images);
    results.push({ file, nodes: flatten(current.frame).length, widthEqual: true, namesEqual: true, wrappersEqual: true, textEqual: true, paintsEqual: true, assetsEqual: true });
  }
  await writeFile('test-results/nested-regression.json', JSON.stringify({ baseline: 'd56ef4a', results }, null, 2));
});

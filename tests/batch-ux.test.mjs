import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createFigmaMock } from './figma-mock.mjs';

let browser, server, base, mainBundle, oldMain, snapshots;
const baseline = process.env.BATCH_UX_BASELINE_SRC;
before(async () => {
  await build({entryPoints:['src/json-snapshots.ts'],bundle:true,outfile:'test-results/json-snapshots.mjs',format:'esm',platform:'node'});
  snapshots=await import('../test-results/json-snapshots.mjs');
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

const ids = s => s.ui.locator('#file-list > li').evaluateAll(rows => rows.map(row => row.dataset.itemId));
const names = s => s.ui.locator('#file-list > li > strong').allTextContents();
async function expectUploadError(s, text) {
  await s.ui.waitForFunction(text => !document.getElementById('upload-error').hidden && document.getElementById('upload-error-message').textContent === text, text);
  assert.equal(await s.ui.locator('#upload-error').count(), 1);
  assert.ok(await s.ui.locator('#upload-error').evaluate(el => el.previousElementSibling.id === 'file' && el.nextElementSibling.id === 'file-list-section'));
}

test('UX selection preserves replacement policy, compares duplicate content and prioritizes the 10-file limit', async () => {
  const s = await session(); try {
    await choose(s, [file('old.html')]); const old = await ids(s);
    await choose(s, [file('same.html', basic('A')), file('same.html', basic('B'))]);
    assert.deepEqual(await names(s), ['1. same.html', '2. same.html']); const valid = await ids(s); assert.ok(!valid.includes(old[0]));
    await choose(s, [file('same.html'), file('same.html')], false, false); await expectUploadError(s, '이미 추가된 파일입니다.');
    assert.deepEqual(await ids(s), valid); assert.ok(await s.ui.locator('#convert').isEnabled());
    await choose(s, Array.from({length:11},()=>file('same.html')), true, false); await expectUploadError(s, 'HTML 파일은 최대 10개까지 선택할 수 있습니다.'); assert.deepEqual(await ids(s), valid);
    await choose(s, [file('same.html')], true); assert.ok(await s.ui.locator('#upload-error').isHidden()); assert.equal(await s.ui.locator('#file-list > li').count(), 1);
    await convert(s); await convert(s); assert.equal(s.mock.figma.currentPage.children.length, 2);
  } finally { await s.page.close(); }
});

test('UX inline upload errors preserve valid reports and are identical for picker and drop', async () => {
  const s = await session(); try {
    await choose(s, [file('valid.html')]); await convert(s); const valid = await ids(s);
    for (const [bad, text] of [[file('bad.txt'),'HTML 파일만 업로드할 수 있습니다.'],[file('empty.html',''),'내용이 없는 HTML 파일은 업로드할 수 없습니다.'],[file('big.html','x'.repeat(5*1024*1024+1)),'파일당 최대 5MB까지 업로드할 수 있습니다.']]) {
      for (const drop of [false,true]) {
        await choose(s,[bad],drop,false); await expectUploadError(s,text);
        assert.deepEqual(await ids(s),valid); assert.equal(await s.ui.locator('#report-file').textContent(),'valid.html');
        assert.equal(await s.ui.locator('#status').getAttribute('data-state'),'success');
      }
    }
    await s.ui.evaluate(()=>{ window.readText=FileReader.prototype.readAsText; FileReader.prototype.readAsText=function(){queueMicrotask(()=>this.dispatchEvent(new Event('error')));}; });
    await choose(s,[file('read.html')],false,false); await expectUploadError(s,'파일을 읽지 못했습니다. 다시 선택해 주세요.');
    await s.ui.evaluate(()=>{FileReader.prototype.readAsText=window.readText;});
    assert.deepEqual(await ids(s),valid); await choose(s,[file('valid.html')]); assert.ok(await s.ui.locator('#upload-error').isHidden());
  } finally { await s.page.close(); }
});

test('UX reorder retains Item ID settings, updates numbers and applies the same order to Canvas on the next conversion', async () => {
  const s=await session(); try {
    await choose(s,[file('A.html'),file('B.html'),file('C.html')]); const original=await ids(s);
    await viewportFor(s,1,360,844); assert.ok(await s.ui.locator('.move-up').first().isDisabled()); assert.ok(await s.ui.locator('.move-down').last().isDisabled());
    await s.ui.locator('.move-up').nth(1).click(); assert.deepEqual(await ids(s),[original[1],original[0],original[2]]);
    assert.deepEqual(await names(s),['1. B.html','2. A.html','3. C.html']);
    await convert(s); assert.deepEqual(creates(s).map(m=>[m.fileName,m.payload.options.viewport]),[['B.html',360],['A.html',1440],['C.html',1440]]);
    const roots=s.mock.figma.currentPage.children.map(node=>({id:node.id,x:node.x,y:node.y}));
    await s.ui.locator('.file-detail').first().click(); await s.ui.locator('.move-down').first().click();
    assert.equal(await s.ui.locator('#report-file').textContent(),'B.html'); assert.deepEqual(s.mock.figma.currentPage.children.map(node=>({id:node.id,x:node.x,y:node.y})),roots);
    await convert(s); assert.deepEqual(creates(s).slice(3).map(m=>m.fileName),['A.html','B.html','C.html']);
  } finally {await s.page.close();}
});

test('UX individual deletion and confirmed clear release only UI results and permit reupload',async()=>{
  const s=await session();try{
    await choose(s,[file('A.html'),file('B.html')]); await s.ui.locator('#clear-files').click(); assert.ok(await s.ui.locator('#clear-confirm').isHidden()); assert.equal(await ids(s).then(x=>x.length),0);
    await choose(s,[file('A.html'),file('B.html')]); await convert(s); await s.ui.locator('.file-detail').first().click();
    await s.ui.locator('.remove-file').first().click(); assert.equal(await s.ui.locator('#report-file').textContent(),'B.html'); assert.equal(s.mock.figma.currentPage.children.length,2);
    await s.ui.locator('#clear-files').click(); assert.ok(await s.ui.locator('#clear-confirm').isVisible()); await s.ui.locator('#clear-confirm-cancel').click(); assert.equal((await ids(s)).length,1);
    await s.ui.locator('#clear-files').click(); await s.ui.locator('#clear-confirm-submit').click();
    assert.equal((await ids(s)).length,0); assert.ok(await s.ui.locator('#report').isHidden()); assert.ok(await s.ui.locator('#batch-summary').isHidden()); assert.ok(await s.ui.locator('#convert').isDisabled()); assert.ok(await s.ui.locator('#upload-error').isHidden());
    assert.equal(s.mock.figma.currentPage.children.length,2); await choose(s,[file('A.html')],true); await s.ui.locator('.remove-file').click(); await choose(s,[file('A.html')]); await convert(s); assert.equal(s.mock.figma.currentPage.children.length,3);
  }finally{await s.page.close();}
});

test('UX conversion locks order, deletion and clear while retaining progress and retry',async()=>{
  const s=await session();try{
    await choose(s,Array.from({length:10},(_,i)=>file(`${i}.html`))); s.hold(); await s.ui.locator('#convert').click(); await until(()=>terminals(s).length===1);
    for(const selector of ['.move-up','.move-down','.remove-file','#clear-files']) assert.ok(await s.ui.locator(selector).evaluateAll(buttons=>buttons.every(button=>button.disabled)),selector);
    await s.ui.evaluate(()=>document.querySelector('.remove-file').click()); assert.equal((await ids(s)).length,10);
    s.release(); await s.ui.waitForFunction(()=>document.getElementById('status').dataset.state==='success'); await s.drain();
    assert.equal(s.mock.figma.currentPage.children.length,10); assert.ok(await s.ui.locator('.remove-file').first().isEnabled());
  }finally{await s.page.close();}
});

async function downloadJSON(s,index){
  await s.ui.locator('.file-detail').nth(index).click();
  await s.ui.locator('#developer-options').evaluate(el=>el.open=true);
  const pending=s.page.waitForEvent('download'); await s.ui.locator('#json').click(); const download=await pending;
  const text=await readFile(await download.path(),'utf8'); return {name:download.suggestedFilename(),text,doc:JSON.parse(text)};
}

test('UX selected Report and every JSON preserve the actual converted data across order and setting changes',async()=>{
  const s=await session();try{
    await choose(s,[file('same.html',basic('A')),file('same.html',basic('B')),file('C.html')]);
    await viewportFor(s,1,360,844); await convert(s);
    assert.equal(await s.ui.locator('#selected-file').textContent(),'1. same.html');
    assert.equal(await s.ui.locator('#file-list > li').first().getAttribute('data-selected'),'true');
    assert.equal(await s.ui.locator('#developer-options').evaluate(el=>el.open),false);
    const saved=creates(s).map(m=>structuredClone(m.payload)),downloads=[];
    for(let i=0;i<3;i++){
      const result=await downloadJSON(s,i); assert.equal(result.text,JSON.stringify(saved[i],null,2)); downloads.push(result.name);
      assert.match(await s.ui.locator('#selected-file').textContent(),new RegExp(`^${i+1}\\.`));
    }
    assert.equal(new Set(downloads).size,3); assert.match(downloads[0],/^same-/);
    await s.ui.locator('.file-detail').nth(1).click(); const selected=(await ids(s))[1];
    await s.ui.locator('.move-up').nth(1).click(); assert.equal((await ids(s))[0],selected);
    assert.equal(await s.ui.locator('#selected-file').textContent(),'1. same.html');
    await viewportFor(s,0,768,1024); const original=await downloadJSON(s,0); assert.equal(original.text,JSON.stringify(saved[1],null,2));
    await convert(s); assert.equal(await s.ui.locator('#file-list > li').first().getAttribute('data-selected'),'true');
    const next=await downloadJSON(s,0); assert.equal(next.text,JSON.stringify(creates(s)[3].payload,null,2)); assert.equal(next.doc.options.viewport,768);
  }finally{await s.page.close();}
});

test('UX waiting and parser failures have no JSON, while converter failures retain labeled analysis data',async()=>{
  const s=await session({failAt:[1]});try{
    await choose(s,[file('failed.html'),file('hidden.html','<style>body{display:none}</style><p>hidden</p>'),file('last.html')]);
    await s.ui.locator('.file-detail').nth(1).click(); assert.equal(await s.ui.locator('#report-empty').textContent(),'아직 변환 결과가 없습니다.'); assert.ok(await s.ui.locator('#json').isDisabled());
    await convert(s); assert.equal(await s.ui.locator('#selected-file').textContent(),'2. hidden.html'); assert.ok(await s.ui.locator('#json').isDisabled());
    assert.equal(await s.ui.locator('#report').getAttribute('data-result'),'ERROR');
    const result=await downloadJSON(s,0); assert.equal(result.text,JSON.stringify(creates(s)[0].payload,null,2)); assert.match(await s.ui.locator('#json-info').textContent(),/분석 데이터 · Frame 생성 실패/);
    await s.ui.locator('.remove-file').first().click(); assert.equal(await s.ui.locator('#selected-file').textContent(),'1. hidden.html'); assert.ok(await s.ui.locator('#json').isDisabled());
    await s.ui.locator('.remove-file').first().click(); assert.equal(await s.ui.locator('#report-file').textContent(),'last.html'); assert.ok(await s.ui.locator('#json').isEnabled());
  }finally{await s.page.close();}
});

test('UX deleting and clearing release snapshot storage and revoke download URLs without removing Canvas frames',async()=>{
  const s=await session();try{
    await s.ui.evaluate(()=>{
      const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL),timeout=window.setTimeout.bind(window);
      window.urls=[];window.revoked=[];
      URL.createObjectURL=blob=>{const url=create(blob);window.urls.push(url);return url;};
      URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url);};
      window.setTimeout=(fn,delay,...args)=>timeout(fn,delay===1000?100000:delay,...args);
    });
    await choose(s,[file('A.html'),file('B.html')]);await convert(s);await downloadJSON(s,0);
    const before=await s.ui.locator('#snapshot-storage').textContent(); await s.ui.locator('.remove-file').first().click();
    assert.ok(await s.ui.evaluate(()=>window.revoked.includes(window.urls[0])));assert.notEqual(await s.ui.locator('#snapshot-storage').textContent(),before);
    await downloadJSON(s,0);await s.ui.locator('#clear-files').click();await s.ui.locator('#clear-confirm-submit').click();
    assert.equal(await s.ui.locator('#snapshot-storage').textContent(),'JSON 보관 합계: 0.0 KB'); assert.ok(await s.ui.evaluate(()=>window.urls.every(url=>window.revoked.includes(url))));
    assert.equal(s.mock.figma.currentPage.children.length,2);await choose(s,[file('A.html')]);assert.ok(await s.ui.locator('#json').isDisabled());
  }finally{await s.page.close();}
});

test('UX streamed snapshots keep the exact version-1 JSON representation, with bounded image chunks and compressed storage',async()=>{
  const doc={version:1,options:{viewport:360,viewportHeight:844},root:{name:'한글',text:'a\nb',children:[]},assets:{one:[0,255,12],empty:[]},warnings:[],unused:undefined};
  const exact=JSON.stringify(doc,null,2);
  for(const compress of [false,true]){
    const saved=await snapshots.createJSONSnapshot(doc,compress); const blob=await snapshots.snapshotJSONBlob(saved);
    assert.equal(await blob.text(),exact); assert.equal(saved.serializedBytes,Buffer.byteLength(exact));assert.equal(blob.type,'application/json');
  }
  const large={...doc,assets:{image:Array.from({length:1024*1024},(_,i)=>i%256)}};
  const saved=await snapshots.createJSONSnapshot(large); assert.ok(saved.blob.size<saved.serializedBytes/20);
  assert.deepEqual(JSON.parse(await (await snapshots.snapshotJSONBlob(saved)).text()),JSON.parse(JSON.stringify(large)));
  await writeFile('test-results/json-snapshot-storage.json',JSON.stringify({sourceImageBytes:large.assets.image.length,serializedBytes:saved.serializedBytes,retainedBlobBytes:saved.blob.size,note:'Storage size measurement; not native Figma or process heap usage'},null,2));
});

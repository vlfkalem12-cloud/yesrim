import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createFigmaMock, flatten } from './figma-mock.mjs';

let browser, server, url, parser, oldParser, converter, oldConverter, sample, actual;
const baseline = process.env.COMPONENT_BASELINE_SRC;
const evidence = { actualFigmaExecuted: false, baseline: 'd1d9cf6' };
const bundle = async entry => (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'Parser' })).outputFiles[0].text;
before(async () => {
  await mkdir('test-results', { recursive: true }); parser = await bundle('src/parser.ts');
  await build({ entryPoints: ['src/converter.ts'], bundle: true, outfile: 'test-results/component-converter.mjs', format: 'esm', platform: 'node' });
  converter = await import('../test-results/component-converter.mjs');
  if (baseline) {
    oldParser = await bundle(resolve(baseline, 'parser.ts'));
    await build({ entryPoints: [resolve(baseline, 'converter.ts')], bundle: true, outfile: 'test-results/component-old-converter.mjs', format: 'esm', platform: 'node' });
    oldConverter = await import('../test-results/component-old-converter.mjs');
  }
  server = createServer((_r,res) => res.end('<div id="host"></div>'));
  await new Promise(done => server.listen(0,'127.0.0.1',done)); url=`http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH || await access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined);
  browser = await chromium.launch({ executablePath, args:['--no-sandbox'] });
  sample = await readFile('test/content-components-regression.html','utf8'); actual = await readFile('test/actual/09-01_A-pc-list.html','utf8');
});
after(async () => { await writeFile('test-results/content-components.json',JSON.stringify(evidence,null,2)); await browser?.close(); if(server) await new Promise(done=>server.close(done)); });
async function parse(html, overrides={}, script=parser) {
  const page=await browser.newPage();
  try {
    await page.route('https://fonts.googleapis.com/**',r=>r.abort()); await page.goto(url); await page.addScriptTag({content:script});
    return JSON.parse(await page.evaluate(async ({html,overrides})=>JSON.stringify(await Parser.parseHTML(html,{viewport:1920,viewportHeight:900,autoLayout:true,styles:true,...overrides},document.getElementById('host'))),{html,overrides}));
  } finally { await page.close(); }
}
async function convert(doc, options={}, implementation=converter) { const mock=createFigmaMock(options);globalThis.figma=mock.figma;return {...await implementation.convertDocument(doc),...mock}; }
const nodes=root=>[root,...root.children.flatMap(nodes)];
const source=(doc,id)=>nodes(doc.root).find(n=>n.source?.id===id);
const find=(frame,id)=>flatten(frame).find(n=>n.originalName===id);
function props(n) { return {name:n.name,layoutMode:n.layoutMode,widthMode:n.layoutSizingHorizontal,heightMode:n.layoutSizingVertical,width:n.width,height:n.height,padding:[n.paddingTop,n.paddingRight,n.paddingBottom,n.paddingLeft],gap:n.itemSpacing,wrap:n.layoutWrap}; }

test('Actual blockified Chips and Badge previously NONE/Fixed become Horizontal/Hug; existing buttons remain untouched', async()=>{
  const doc=await parse(actual),result=await convert(doc);
  const wanted=['집을 팔려고 해요','두 채 중 하나를 팔아요','간편'];
  const selected=flatten(result.frame).filter(n=>n.type==='FRAME'&&n.children.length===1&&wanted.includes(n.children[0].characters));
  assert.equal(selected.length,3);
  for(const n of selected) {assert.equal(n.layoutMode,'HORIZONTAL');assert.equal(n.layoutSizingHorizontal,'HUG');assert.equal(n.layoutSizingVertical,'HUG');assert.equal(n.counterAxisAlignItems,'CENTER');assert.equal(n.children[0].layoutSizingHorizontal,'HUG');assert.equal(n.children[0].textAutoResize,'WIDTH_AND_HEIGHT');}
  const t=doc.root.children[2], inner=t.children[0], list=inner.children[1];
  assert.equal(t.size.heightMode,'HUG');assert.equal(list.layout.wrapSpacing,20);assert.equal(list.children.length,6);
  const chipRow=list.children[0].children[2].children[1];
  assert.equal(chipRow.layout.direction,'HORIZONTAL');assert.equal(chipRow.size.heightMode,'HUG');assert.equal(chipRow.layout.wrapSpacing,6);
  evidence.actualAfter=selected.map(n=>({...props(n),text:n.children[0].characters,textResize:n.children[0].textAutoResize}));
  if(baseline) {
    const oldDoc=await parse(actual,{},oldParser),old=await convert(oldDoc,{},oldConverter);
    evidence.actualBefore=flatten(old.frame).filter(n=>n.type==='FRAME'&&n.children.length===1&&wanted.includes(n.children[0].characters)).map(props);
    assert.ok(evidence.actualBefore.every(n=>n.layoutMode==='NONE'&&n.widthMode==='FIXED'&&n.heightMode==='FIXED'));
    for(const text of ['AI에게 묻기','계산하기']) {
      const select=r=>flatten(r.frame).find(n=>n.type==='FRAME'&&n.children.length===1&&n.children[0].characters===text);
      assert.deepEqual(props(select(result)),props(select(old)));
    }
  }
});

test('Basic Chip/Badge/Button keep paint, padding, radius and one Text in the same existing Frame', async()=>{
  const doc=await parse(sample),result=await convert(doc);
  for(const id of ['chip','chip-long','badge','button']) {
    const parsed=source(doc,id),n=find(result.frame,id);
    assert.equal(parsed.layout.contentComponent,true,id);assert.equal(n.layoutMode,'HORIZONTAL',id);assert.equal(n.layoutSizingHorizontal,'HUG',id);assert.equal(n.layoutSizingVertical,'HUG',id);
    assert.equal(n.children.length,1,id);assert.equal(n.children[0].type,'TEXT');assert.equal(n.children[0].textAutoResize,'WIDTH_AND_HEIGHT');
    assert.deepEqual([n.paddingTop,n.paddingRight,n.paddingBottom,n.paddingLeft],Object.values(parsed.layout.padding));
    assert.equal(n.topLeftRadius,parsed.style.radii[0]);assert.ok(n.fills.length);assert.equal(n.children[0].lineHeight.value,20);
  }
  assert.deepEqual([find(result.frame,'chip').width,find(result.frame,'chip').height],[source(doc,'chip').rect.width,source(doc,'chip').rect.height]);
  assert.equal(source(doc,'chip').style.whiteSpace,'nowrap');
});

test('An icon + text button is Horizontal with measured Gap and keeps the vector and original source order', async()=>{
  const doc=await parse(sample),parsed=source(doc,'icon-button'),result=await convert(doc),n=find(result.frame,'icon-button');
  assert.equal(parsed.layout.contentComponent,true);assert.equal(n.layoutMode,'HORIZONTAL');assert.equal(n.counterAxisAlignItems,'CENTER');
  assert.equal(n.children[0].type,'TEXT');assert.equal(n.children[1].getPluginData('html-type'),'svg');
  assert.equal(n.itemSpacing,parsed.children[1].rect.x-parsed.children[0].rect.x-parsed.children[0].rect.width);
  assert.ok(n.itemSpacing>0);
  assert.equal(n.children[1].layoutSizingHorizontal,'FIXED');assert.equal(n.children[0].layoutSizingHorizontal,'HUG');
});

test('Fixed/Fill, constraints, multiline, Absolute, plain and Rich Text are excluded; Auto Layout off remains measured', async()=>{
  const doc=await parse(sample);
  for(const id of ['fixed','fill','constrained','inner-constraint','block-fill','long','positioned','plain','rich']) assert.notEqual(source(doc,id)?.layout.contentComponent,true,id);
  assert.equal(source(doc,'fixed').size.authoredWidth,'220px');assert.equal(source(doc,'fixed').size.authoredHeight,'44px');assert.equal(source(doc,'fill').size.widthMode,'FILL');
  assert.ok(nodes(source(doc,'rich')).some(n=>n.ranges?.length));assert.equal(source(doc,'hidden'),undefined);
  const off=await parse(sample,{autoLayout:false});assert.notEqual(source(off,'chip').layout.contentComponent,true);assert.equal(source(off,'chip').layout.direction,'NONE');
});

test('Controlled Text box expansion propagates Hug width without inventing Figma font metric or native editing evidence', async()=>{
  const result=await convert(await parse(sample),{simulateAutoWidth:true,simulateHugWidth:true,simulateAutoHeight:true});
  for(const [id,text] of [['chip','집 두 채 중 하나를 팔려고 해요'],['badge','시뮬레이션'],['button','양도소득세 계산하기']]) {
    const frame=find(result.frame,id),label=frame.children[0],before=frame.width,height=frame.height;
    label.characters=text;label.width+=120;
    assert.equal(frame.width-before,120,id);assert.equal(frame.height,height,id);
    assert.equal(frame.width,label.width+frame.paddingLeft+frame.paddingRight+(frame.strokeLeftWeight||0)+(frame.strokeRightWeight||0));
  }
});

test('Actual initial component boxes and native chip-row positions match original browser rectangles; Card List stays three columns',async()=>{
  const doc=await parse(actual),result=await convert(doc,{simulateAutoWidth:true,simulateHugWidth:true,simulateAutoHeight:true,simulateAutoPosition:true});
  const characters=node=>node.type==='TEXT'?(node.text||node.characters||''):node.children.map(characters).join('\u0000');
  const marked=nodes(doc.root).filter(n=>n.layout.contentComponent),findBox=parsed=>flatten(result.frame).find(n=>n.type==='FRAME'&&n.name===parsed.layerName&&n.getPluginData('html-source')===parsed.source.selector&&characters(n)===characters(parsed));
  for(const parsed of marked) {
    const frame=findBox(parsed);assert.ok(frame,parsed.layerName);
    assert.ok(Math.abs(frame.width-parsed.rect.width)<.05,`${frame.name}: original width`);assert.ok(Math.abs(frame.height-parsed.rect.height)<.05,`${frame.name}: original line box + padding height`);
  }
  let rows=0;
  // Scope the limited Fill box model to the reported Tax/Card List chain;
  // other Hero Fill contexts are covered by full before/after IR and API snapshots.
  for(const parsed of nodes(doc.root.children[2]).filter(n=>n.layout.wrapSpacing!==undefined&&n.children.some(child=>child.layout.contentComponent))) {
    const frame=findBox(parsed);rows++;
    for(const [i,child] of parsed.children.entries()) {
      assert.ok(Math.abs(frame.children[i].x-(child.rect.x-parsed.rect.x))<.1,JSON.stringify({row:parsed.layerName,label:characters(child),actualX:frame.children[i].x,expectedX:child.rect.x-parsed.rect.x,width:frame.width,sourceWidth:parsed.rect.width,widths:frame.children.map(n=>n.width),sourceWidths:parsed.children.map(n=>n.rect.width)}));
      assert.ok(Math.abs(frame.children[i].y-(child.rect.y-parsed.rect.y))<.1,JSON.stringify({row:parsed.layerName,child:child.layerName,actualY:frame.children[i].y,expectedY:child.rect.y-parsed.rect.y,width:frame.width,sourceWidth:parsed.rect.width,align:frame.counterAxisAlignItems,heights:frame.children.map(n=>n.height),sourceHeights:parsed.children.map(n=>n.rect.height)}));
    }
    assert.ok(Math.abs(frame.height-parsed.rect.height)<.1,'Initial row height unchanged');
  }
  const list=result.frame.children[2].children[0].children[1];
  assert.equal(list.layoutWrap,'WRAP');assert.equal(new Set(list.children.map(n=>Math.round(n.x))).size,3);assert.equal(new Set(list.children.map(n=>n.y)).size,2);
  evidence.initialBoxProjection={components:marked.length,rows,originalWidthsHeightsAndChipPositionsEqual:true,threeColumns:true,nativeFontMetricsSimulated:false};
});

test('Controlled Chip text width rewraps its row and propagates through Card/Section/Next; Icon moves after text width changes',async()=>{
  const result=await convert(await parse(actual),{simulateAutoWidth:true,simulateHugWidth:true,simulateAutoHeight:true,simulateAutoPosition:true});
  const tax=result.frame.children[2],next=result.frame.children[3],first=tax.children[0].children[1].children[0];
  const chip=flatten(first).find(n=>n.type==='FRAME'&&n.children.length===1&&n.children[0].characters==='집을 팔려고 해요');
  const label=chip.children[0],row=chip.parent,before={width:label.width,row:row.height,tax:tax.height,next:next.y};
  label.characters='집 두 채 중 하나를 팔려고 해요';label.width+=80;
  assert.equal(chip.width-label.width,24);assert.ok(row.height>before.row);assert.ok(tax.height>before.tax);assert.ok(next.y>before.next);assert.ok(next.y>=tax.y+tax.height);
  label.width=before.width;assert.equal(row.height,before.row);assert.equal(tax.height,before.tax);assert.equal(next.y,before.next);
  const buttonResult=await convert(await parse(sample),{simulateAutoWidth:true,simulateHugWidth:true,simulateAutoHeight:true,simulateAutoPosition:true});
  const button=find(buttonResult.frame,'icon-button'),text=button.children[0],icon=button.children[1],oldX=icon.x,oldHeight=button.height;
  text.width+=120;assert.equal(icon.x-oldX,120);assert.equal(button.height,oldHeight);assert.equal(icon.y-button.paddingTop-button.strokeTopWeight,(text.height-icon.height)/2);
  evidence.controlledWidthGrowth={rowAndAncestorsExpand:true,nextMovesAndRestores:true,iconFollowsText:true,nativeFigmaEditing:false};
});

function snapshot(n) {
  return { type:n.type,name:n.name,width:n.width,height:n.height,x:n.parent?.type==='PAGE'?0:n.x,y:n.parent?.type==='PAGE'?0:n.y,
    horizontal:n.layoutSizingHorizontal,vertical:n.layoutSizingVertical,layout:n.layoutMode,wrap:n.layoutWrap,gap:n.itemSpacing,
    padding:[n.paddingTop,n.paddingRight,n.paddingBottom,n.paddingLeft],align:n.counterAxisAlignItems,justify:n.primaryAxisAlignItems,
    primary:n.primaryAxisSizingMode,counter:n.counterAxisSizingMode,minWidth:n.minWidth,maxWidth:n.maxWidth,minHeight:n.minHeight,maxHeight:n.maxHeight,
    radii:[n.topLeftRadius,n.topRightRadius,n.bottomRightRadius,n.bottomLeftRadius],fills:n.fills,strokes:n.strokes,effects:n.effects,opacity:n.opacity,clips:n.clipsContent,
    text:n.characters,font:n.fontName,fontSize:n.fontSize,lineHeight:n.lineHeight,resize:n.textAutoResize,ranges:n.rangeStyles,children:n.children.map(snapshot) };
}
function restoreComponentIR(current,previous) {
  const copy=structuredClone(current);
  const rows=new Map();
  const visit=(node,old)=>{
    assert.equal(node.children.length,old.children.length,`${node.name}: no wrapper/node addition`);
    const row = node.layout.wrapSpacing!==undefined && old.layout.wrapSpacing===undefined && node.children.some(child=>child.layout.contentComponent);
    if(row) {
      assert.equal(old.layout.direction,'NONE');assert.equal(node.layout.direction,'HORIZONTAL');assert.equal(node.size.widthMode,old.size.widthMode);
      assert.equal(node.size.width,old.size.width);assert.equal(node.size.height,old.size.height);assert.equal(node.layout.gap,old.layout.gap);
      assert.deepEqual(node.layout.padding,old.layout.padding);assert.equal(node.layout.wrapSpacing,node.layout.gap);
      rows.set(node.name,(rows.get(node.name)||0)+1);
    }
    if(node.layout.contentComponent || row) {
      node.layout=structuredClone(old.layout);node.size=structuredClone(old.size);
      if(!row) for(const [i,child] of node.children.entries()) {
        child.size=structuredClone(old.children[i].size);child.layout=structuredClone(old.children[i].layout);child.style.lineHeight=old.children[i].style.lineHeight;
      }
    }
    node.children.forEach((child,i)=>visit(child,old.children[i]));
  };
  visit(copy.root,previous.root);
  for(const [name,count] of rows) {
    const occurrences=(warnings)=>warnings.filter(w=>w.code==='FLEX_WRAP'&&w.node===name).reduce((sum,w)=>sum+(w.occurrences||1),0);
    assert.equal(occurrences(previous.warnings)-occurrences(copy.warnings),count,'Only verified chip-row fallbacks disappear');
  }
  const keep=w=>!(w.code==='FLEX_WRAP'&&rows.has(w.node));
  assert.deepEqual(copy.warnings.filter(keep),previous.warnings.filter(keep));copy.warnings=structuredClone(previous.warnings);
  return copy;
}
function restoreComponentSnapshot(current,previous,componentNames,rowNames) {
  const visit=(node,old)=>{
    assert.equal(node.children.length,old.children.length,`${node.name}: wrappers/children unchanged`);
    if(componentNames.has(node.name)) {
      for(const key of ['horizontal','vertical','layout','gap','padding','align','justify','primary','counter']) node[key]=old[key];
      for(const [i,child] of node.children.entries()) for(const key of ['horizontal','vertical','height','x','y','lineHeight','resize']) child[key]=old.children[i][key];
    }
    if(rowNames.has(node.name)&&old.layout==='NONE'&&node.wrap==='WRAP') {
      for(const key of ['vertical','layout','wrap','gap','padding','align','justify','primary','counter']) node[key]=old[key];
      // This baseline uses a mock with native positions disabled. Only the verified
      // row moves direct children from stored CSS coordinates to Auto Layout coordinates.
      for(const [i,child] of node.children.entries()) { child.x=old.children[i].x;child.y=old.children[i].y; }
    }
    node.children.forEach((child,i)=>visit(child,old.children[i]));
  }; visit(current,previous);return current;
}
test('Only approved atomic components change against d1d9cf6; every ancestor and all other layout/style/name/ranges/assets stay equal', {skip:!baseline}, async()=>{
  for(const file of ['layer-naming.ts','rich-text.ts','inline-layout.ts','sizing.ts','grid.ts','svg.ts','gradients.ts','backgrounds.ts','form-controls.ts','optimizer.ts','report.ts','assets.ts','code.ts','ui.ts','ui.html','converter.ts'])
    assert.equal(await readFile(`src/${file}`,'utf8'),await readFile(resolve(baseline,file),'utf8'),`${file} unchanged`);
  const outcomes=[];
  for(const file of ['test/actual/09-01_A-pc-list.html','examples/mvp.html','test/dashboard-rendering-regression.html','test/form-controls-regression.html','test/fixed-position-regression.html','test/phase2-test.html','test/rendering-regression.html','test/gradient-regression.html','test/inline-accessibility-regression.html','test/layer-naming-regression.html','test/rich-text-regression.html','test/nested-hug-regression.html']) {
    const html=await readFile(file,'utf8'),old=await parse(html,{},oldParser),doc=await parse(html);
    assert.deepEqual(restoreComponentIR(doc,old),old,`${file}: entire IR outside approved component fields`);
    const before=await convert(old,{},oldConverter),after=await convert(doc),components=new Set(nodes(doc.root).filter(n=>n.layout.contentComponent).map(n=>n.layerName||n.name));
    const rows=new Set(nodes(doc.root).filter(n=>n.layout.wrapSpacing!==undefined&&n.children.some(child=>child.layout.contentComponent)).map(n=>n.layerName||n.name));
    assert.deepEqual(restoreComponentSnapshot(snapshot(after.frame),snapshot(before.frame),components,rows),snapshot(before.frame),`${file}: full tree outside component/verified chip-row layout`);
    assert.deepEqual(after.svgImports,before.svgImports);assert.deepEqual(after.images,before.images);
    for(const key of ['total','frames','text','image','grid','svg','absolute']) assert.equal(after.report[key],before.report[key]);
    outcomes.push({file,components:components.size,nodes:after.report.total,unchangedAncestors:true,paintsNamesRangesAssetsEqual:true});
  }
  evidence.regression=outcomes;
});

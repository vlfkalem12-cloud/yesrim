import { sourceChildren } from './alignment-compat.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,access,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createFigmaMock,flatten} from './figma-mock.mjs';
let browser,parser,converter,oldConverter;
const baseline=process.env.ALIGNMENT_BASELINE_SRC;
before(async()=>{
 await mkdir('test-results',{recursive:true});
 parser=(await build({entryPoints:['src/parser.ts'],bundle:true,write:false,format:'iife',globalName:'Parser'})).outputFiles[0].text;
 await build({entryPoints:['src/converter.ts'],bundle:true,outfile:'test-results/alignment-current.mjs',format:'esm',platform:'node'});converter=await import('../test-results/alignment-current.mjs');
 if(baseline){await build({entryPoints:[resolve(baseline,'converter.ts')],bundle:true,outfile:'test-results/alignment-baseline.mjs',format:'esm',platform:'node'});oldConverter=await import('../test-results/alignment-baseline.mjs');}
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||await access('/usr/bin/chromium').then(()=>'/usr/bin/chromium',()=>undefined),args:['--no-sandbox']});
});
after(async()=>await browser?.close());
const options={viewport:360,viewportHeight:844,autoLayout:true,styles:true};
async function parse(html,settings={}){
 const page=await browser.newPage();try{
  await page.route('https://fonts.googleapis.com/**',route=>route.abort());await page.setContent('<div id="host"></div>');await page.addScriptTag({content:parser});
  return JSON.parse(await page.evaluate(async({html,options})=>{
   const rendered=await Parser.renderHTML(html,options.viewport,options.viewportHeight,document.getElementById('host'));
   try{
    const elements=[...rendered.document.querySelectorAll('body *')].map(el=>{const css=rendered.document.defaultView.getComputedStyle(el),r=el.getBoundingClientRect();
      return {tag:el.localName,text:el.textContent.trim(),rect:{x:r.x,y:r.y,width:r.width,height:r.height},alignSelf:css.alignSelf,justify:css.justifyContent,align:css.alignItems,textAlign:css.textAlign};});
    return JSON.stringify({doc:await Parser.parseRenderedHTML(rendered,options),elements});
   }finally{rendered.dispose();}
  },{html,options:{...options,...settings}}));
 }finally{await page.close();}
}
const irNodes=root=>[root,...root.children.flatMap(irNodes)];
function pairs(doc,frame){
 const result=new Map();const visit=(p,n)=>{result.set(p,n);if(p.type!=='FRAME')return;
  const children=n.children.filter(child=>!child.getPluginData('html-background-grid-line'));
  assert.equal(children.length,p.children.length,`${p.layerName}: source children preserved`);
  p.children.forEach((child,i)=>{let node=children[i];while(!node.getPluginData('html-source')&&node.children.length===1)node=node.children[0];visit(child,node);});
 };visit(doc.root,frame);return result;
}
async function convert(doc,implementation=converter,extra={}){
 const mock=createFigmaMock({simulateAutoWidth:true,simulateHugWidth:true,simulateAutoHeight:true,simulateAutoPosition:true,simulateSizingCoupling:true,rejectDeprecatedAlignment:true,...extra});
 globalThis.figma=mock.figma;return {...await implementation.convertDocument(doc),...mock};
}
const summary=node=>({name:node.name,layoutMode:node.layoutMode,widthMode:node.layoutSizingHorizontal,heightMode:node.layoutSizingVertical,primaryAlign:node.primaryAxisAlignItems,counterAlign:node.counterAxisAlignItems,width:node.width,height:node.height,x:node.x,y:node.y});
const close=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<.1,`${message}: ${actual} vs ${expected}`);

test('Sheet align-self:center survives Computed Style and IR, reuses its margin Frame and stays centered through edits',{skip:!baseline},async()=>{
 const html=await readFile('test/actual/A01-02_A1-sheet.html','utf8');const {doc,elements}=await parse(html);
 const css=elements.find(e=>e.alignSelf==='center');assert.equal(css.rect.x,160);const parsed=irNodes(doc.root).find(n=>n.layout.alignSelf==='center');assert.equal(parsed.size.widthMode,'FIXED');assert.equal(parsed.layout.margin.bottom,8);
 const old=await convert(doc,oldConverter),before=pairs(doc,old.frame).get(parsed);assert.equal(before.parent.width,40);assert.equal(before.x,0);assert.ok(old.report.warnings.some(w=>w.code==='ALIGN_SELF'));
 const result=await convert(doc),handle=pairs(doc,result.frame).get(parsed),wrapper=handle.parent,sheet=wrapper.parent;
 assert.equal(wrapper.getPluginData('html-align-self'),'center');assert.equal(wrapper.layoutMode,'VERTICAL');assert.equal(wrapper.counterAxisAlignItems,'CENTER');assert.equal(wrapper.layoutSizingHorizontal,'FILL');assert.equal(wrapper.layoutSizingVertical,'HUG');assert.equal(wrapper.paddingBottom,8);
 assert.equal(handle.layoutSizingHorizontal,'FIXED');assert.equal(handle.width,40);assert.equal(handle.height,4);close(handle.x,css.rect.x,'Centered local X');
 assert.equal(result.report.total,old.report.total,'Reuse margin Frame; no extra source layer');assert.deepEqual(flatten(result.frame).map(n=>n.name),flatten(old.frame).map(n=>n.name),'Existing Naming untouched');assert.ok(!result.report.warnings.some(w=>w.code==='ALIGN_SELF'));
 const initial={css,ir:{alignSelf:parsed.layout.alignSelf,widthMode:parsed.size.widthMode,heightMode:parsed.size.heightMode},before:{handle:summary(before),wrapper:summary(before.parent)},after:{handle:summary(handle),wrapper:summary(wrapper),sheet:summary(sheet)}};
 sheet.resize(420,sheet.height);close(handle.x,190,'Center follows parent width');handle.resize(60,4);close(handle.x,180,'Center follows own width');assert.equal(wrapper.height,12,'Original bottom margin preserved');
 await writeFile('test-results/alignment-sheet.json',JSON.stringify({...initial,edited:{handle:summary(handle),wrapper:summary(wrapper)},nativeFigmaEditorTested:false},null,2));
});

test('Center alignment without margins uses one transparent Native Auto Layout helper and keeps source sizing',async()=>{
 const {doc}=await parse('<main style="display:flex;flex-direction:column;width:360px"><div id="item" style="align-self:center;width:40px;height:4px;background:red"></div><div style="height:20px"></div></main>');
 const item=irNodes(doc.root).find(n=>n.name==='item'),result=await convert(doc),node=pairs(doc,result.frame).get(item);
 assert.equal(node.parent.name,'Alignment');assert.deepEqual(node.parent.fills,[]);assert.equal(node.parent.layoutPositioning,'AUTO');assert.equal(node.parent.layoutSizingHorizontal,'FILL');assert.equal(node.width,40);close(node.x,160,'Native center');
 node.resize(80,8);close(node.x,140,'Width edit');assert.equal(node.parent.height,8,'Helper hugs edited child');
});

test('Center helper API failure retains the source node and reports the safe parent-alignment fallback',async()=>{
 const {doc}=await parse('<main style="display:flex;flex-direction:column;width:360px"><div id="item" style="align-self:center;width:40px;height:4px"></div></main>');
 const result=await convert(doc,converter,{rejectSizingAxis:n=>n.name==='Alignment'});assert.equal(flatten(result.frame).filter(n=>n.getPluginData('html-source')==='div#item').length,1);assert.ok(result.report.warnings.some(w=>w.code==='ALIGN_SELF'));assert.ok(!result.report.warnings.some(w=>w.code==='NODE_FAILED'));
});

test('Auto Layout off and absolute children retain measured geometry without alignment helpers',async()=>{
 for(const [html,opts]of [['<main style="display:flex;flex-direction:column;width:360px"><div style="align-self:center;width:40px;height:4px"></div></main>',{autoLayout:false}],['<main style="display:flex;flex-direction:column;width:360px;position:relative"><div style="align-self:center;position:absolute;left:25px;width:40px;height:4px"></div></main>',{}]]){
  const {doc}=await parse(html,opts),result=await convert(doc);assert.ok(!flatten(result.frame).some(n=>n.getPluginData('html-align-self')));
 }
});

function offset(node,root){let x=0,y=0;while(node!==root){x+=node.x;y+=node.y;node=node.parent;if(!node)break;}return{x,y};}

test('Chat keeps bottom-justified Fill flow, right/left messages and centered text editable with native alignment',async()=>{
 const {doc,elements}=await parse(await readFile('test/actual/A03-01_B3-chat.html','utf8'));
 const all=irNodes(doc.root),user=all.find(n=>n.layout.alignSelf==='flex-end'),assistant=all.find(n=>n.layout.alignSelf==='flex-start'),conversation=all.find(n=>n.layout.justify==='MAX'&&n.size.heightMode==='FILL');
 const css=elements.find(e=>e.alignSelf==='flex-end');assert.equal(user.layout.alignSelf,'flex-end');assert.equal(conversation.layout.justify,'MAX');
 const result=await convert(doc,converter,{simulateAlignment:true}),map=pairs(doc,result.frame),bubble=map.get(user),reply=map.get(assistant),body=map.get(conversation),helper=bubble.parent;
 assert.equal(helper.counterAxisAlignItems,'MAX');assert.equal(helper.layoutSizingHorizontal,'FILL');assert.equal(helper.layoutSizingVertical,'HUG');
 assert.equal(bubble.layoutMode,'VERTICAL');assert.equal(bubble.layoutSizingVertical,'HUG');assert.equal(bubble.layoutSizingHorizontal,'FIXED');assert.equal(bubble.width,user.rect.width,'Measured outer width preserved');assert.equal(bubble.children[0].layoutSizingHorizontal,'FILL');
 assert.equal(body.primaryAxisAlignItems,'MAX');assert.equal(body.layoutSizingVertical,'FILL');assert.equal(reply.parent,body);assert.equal(reply.x,16,'flex-start preserved');
 close(offset(bubble,result.frame).x,css.rect.x,'Browser right alignment');
 const para=all.find(n=>n.type==='TEXT'&&n.text?.startsWith('AI 상담 답변은')),text=map.get(para),composer=text.parent.parent;
 assert.equal(text.textAlignHorizontal,'CENTER');assert.equal(text.layoutSizingHorizontal,'FILL');assert.equal(composer.layoutMode,'VERTICAL');assert.equal(composer.layoutSizingVertical,'HUG');assert.equal(text.parent.paddingLeft,10);assert.equal(text.parent.paddingBottom,8);
 const before={bubble:summary(bubble),helper:summary(helper),conversation:summary(body),assistant:summary(reply),composer:summary(composer),centerText:{...summary(text),textAlign:text.textAlignHorizontal}};
 const originalTextHeight=bubble.children[0].height,oldHeight=bubble.height,oldY=helper.y,last=body.children.at(-1),lastY=last.y;
 bubble.children[0].resize(bubble.children[0].width,originalTextHeight+42);
 close(bubble.height,oldHeight+42,'Text height propagates');close(helper.y,oldY-42,'Bottom justification accommodates growth');close(last.y,lastY,'Last row stays bottom anchored');assert.ok(helper.y+helper.height+14<=reply.y+.1,'No overlap');
 const replyTextFrame=reply.children[0],replyHeight=reply.height;assert.equal(replyTextFrame.layoutMode,'VERTICAL');replyTextFrame.children[0].resize(replyTextFrame.children[0].width,replyTextFrame.children[0].height+30);close(reply.height,replyHeight+30,'Assistant text height propagates');
 result.frame.resize(420,844);close(offset(bubble,result.frame).x,result.frame.width-16-bubble.width,'Right anchor follows parent width');assert.equal(text.width,372,'Centered text bounds follow parent width');
 const oldBodyHeight=body.height;text.resize(text.width,text.height+18);close(body.height,oldBodyHeight-18,'Composer expansion reduces middle Fill');
 assert.ok(!result.report.warnings.some(w=>w.code==='ALIGN_SELF'));assert.equal(result.svgImports.length,all.filter(n=>n.type==='SVG').length,'All original SVGs retained');
 if(oldConverter){const previous=await convert(doc,oldConverter);assert.deepEqual(result.svgImports,previous.svgImports,'Native SVG serialization unchanged');}
 await writeFile('test-results/alignment-chat.json',JSON.stringify({computed:css,ir:{alignSelf:user.layout.alignSelf,justify:conversation.layout.justify,textAlign:para.style.textAlign},before,edited:{bubble:summary(bubble),conversation:summary(body),centerText:summary(text)},reportWarnings:result.report.warnings,nativeFigmaEditorTested:false,boxSimulationNotNativeTextEditing:true},null,2));
});

test('Chat header space-between and composer flex-end retain native properties through parent/control edits',async()=>{
 const {doc}=await parse(await readFile('test/actual/A03-01_B3-chat.html','utf8')),result=await convert(doc,converter,{simulateAlignment:true}),map=pairs(doc,result.frame),all=irNodes(doc.root);
 for(const parsed of all.filter(n=>n.layout.direction==='HORIZONTAL'&&n.layout.justify==='SPACE_BETWEEN')){
  const row=map.get(parsed);assert.equal(row.primaryAxisAlignItems,'SPACE_BETWEEN');assert.equal(row.counterAxisAlignItems,'CENTER');
  const last=row.children.at(-1);close(last.x+last.width,row.width-row.paddingRight-(row.strokeRightWeight||0),'Header last item stays at right edge');
 }
 const parsed=all.find(n=>n.layout.direction==='HORIZONTAL'&&n.layout.align==='MAX'),row=map.get(parsed),textarea=row.children.find(n=>n.getPluginData('html-source')==='textarea#b3msg'),button=row.children.at(-1);
 assert.equal(row.counterAxisAlignItems,'MAX');textarea.resize(textarea.width,70);
 close(button.y+button.height,row.height-row.paddingBottom-(row.strokeBottomWeight||0),'Send button remains bottom aligned');
 assert.equal(row.layoutSizingHorizontal,'FILL');assert.ok(row.children.filter(n=>n.getPluginData('html-type')==='svg').every(n=>n.layoutPositioning==='AUTO'));
});

test('Native align-self start/end/center work on fixed and Hug children in both axes without deprecated layoutAlign',async()=>{
 for(const direction of ['column','row'])for(const self of ['flex-start','center','flex-end']){
  const {doc}=await parse(`<style>body{margin:0}</style><main style="width:360px;height:200px;display:flex;flex-direction:${direction};align-items:center;padding:10px;box-sizing:border-box"><div id="item" style="width:40px;height:20px;align-self:${self}"></div><div style="width:30px;height:30px"></div></main>`);
  const result=await convert(doc,converter,{simulateAlignment:true}),p=irNodes(doc.root).find(n=>n.name==='item'),n=pairs(doc,result.frame).get(p),point=offset(n,result.frame);
  const space=direction==='column'?340-40:180-20,target=10+(self==='center'?space/2:self==='flex-end'?space:0);
  close(direction==='column'?point.x:point.y,target,`${direction}/${self}`);assert.equal(n.width,40);assert.equal(n.height,20);
 }
});

test('Wrap and cross-axis Hug fallback never introduce a Fill dependency or alter parent sizing',async()=>{
 for(const html of ['<main style="display:flex;align-items:flex-start;flex-wrap:wrap;width:360px"><div id="item" style="align-self:center;width:40px;height:20px"></div></main>','<main style="display:inline-flex;flex-direction:column;align-items:flex-start"><div id="item" style="align-self:center;width:40px;height:20px"></div></main>']){
  const {doc}=await parse(html),result=await convert(doc);assert.ok(!flatten(result.frame).some(n=>n.getPluginData('html-align-self')));assert.ok(!result.report.warnings.some(w=>w.code==='SIZING_CYCLE'));
 }
});


test('Hug chip text edits keep its own Hug modes and native individual right alignment',async()=>{
 const {doc}=await parse('<style>body{margin:0}</style><main style="display:flex;flex-direction:column;width:360px"><span style="align-self:flex-end;padding:6px 12px;border-radius:8px;background:red;white-space:nowrap">NEW</span></main>');
 const parsed=irNodes(doc.root).find(n=>n.layout.contentComponent),result=await convert(doc),chip=pairs(doc,result.frame).get(parsed);
 assert.equal(chip.layoutSizingHorizontal,'HUG');assert.equal(chip.layoutSizingVertical,'HUG');assert.equal(chip.parent.counterAxisAlignItems,'MAX');
 const width=chip.width,x=chip.x;chip.children[0].resize(chip.children[0].width+20,chip.children[0].height);close(chip.width,width+20,'Chip stays Hug');close(chip.x,x-20,'Right alignment follows Hug text');
});

test('4304645 protection: full IR, source nodes, paints, names, text/ranges and assets stay equal outside approved alignment helpers',{skip:!baseline},async()=>{
 for(const name of await readdir(baseline))if(name.endsWith('.ts')&&name!=='converter.ts')assert.equal(await readFile(`src/${name}`,'utf8'),await readFile(resolve(baseline,name),'utf8'),`${name}: unchanged`);
 assert.equal(await readFile('src/ui.html','utf8'),await readFile(resolve(baseline,'ui.html'),'utf8'),'Batch UI HTML unchanged');
 const files=['test/actual/09-01_A-pc-list.html','examples/mvp.html','test/dashboard-rendering-regression.html','test/form-controls-regression.html','test/fixed-position-regression.html','test/phase2-test.html','test/rendering-regression.html','test/gradient-regression.html','test/inline-accessibility-regression.html','test/layer-naming-regression.html','test/rich-text-regression.html','test/content-components-regression.html'];
 const oldParser=(await build({entryPoints:[resolve(baseline,'parser.ts')],bundle:true,write:false,format:'iife',globalName:'OldParser'})).outputFiles[0].text,evidence=[];
 const snapshot=n=>{
  const properties={};for(const key of [...new Set([...Object.keys(n),'layoutSizingHorizontal','layoutSizingVertical','layoutWrap','fontName','characters','textAutoResize'])].sort()){
   if(['id','parent','children','originalName'].includes(key)||typeof n[key]==='function')continue;
   properties[key]=JSON.parse(JSON.stringify(n[key])||'null');
  }
  properties.metadata=Object.fromEntries(['html-source','html-type','html-position','html-absolute','html-grid','html-background-image'].map(key=>[key,n.getPluginData(key)]));
  properties.children=sourceChildren(n).map(snapshot);return properties;
 };
 for(const file of files){
  const html=await readFile(file,'utf8'),{doc}=await parse(html,{viewport:1920,viewportHeight:900});
  const page=await browser.newPage();let oldDoc;try{await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.setContent('<div id="host"></div>');await page.addScriptTag({content:oldParser});
   oldDoc=JSON.parse(await page.evaluate(async({html,options})=>JSON.stringify(await OldParser.parseHTML(html,options,document.getElementById('host'))),{html,options:doc.options}));
  }finally{await page.close();}
  assert.deepEqual(doc,oldDoc,`${file}: full IR`);
  const priorMock=createFigmaMock();globalThis.figma=priorMock.figma;const prior=await oldConverter.convertDocument(oldDoc);
  const mock=createFigmaMock();globalThis.figma=mock.figma;const current=await converter.convertDocument(doc);
  assert.deepEqual(snapshot(current.frame),snapshot(prior.frame),`${file}: every existing API property/name/paint/range`);
  assert.deepEqual(mock.svgImports,priorMock.svgImports);assert.deepEqual(mock.images,priorMock.images);assert.deepEqual(mock.fontLoads,priorMock.fontLoads);
  const helpers=flatten(current.frame).filter(n=>n.getPluginData('html-alignment-wrapper')==='true');assert.equal(helpers.length,file.includes('09-01_A-pc-list')?2:0);
  const warnings=report=>report.warnings.filter(w=>w.code!=='ALIGN_SELF');assert.deepEqual(warnings(current.report),warnings(prior.report),`${file}: non-alignment warnings`);
  for(const key of ['text','image','grid','absolute','svg'])assert.equal(current.report[key],prior.report[key],`${file}: ${key} count`);
  evidence.push({file,nodesBefore:prior.report.total,nodesAfter:current.report.total,alignmentHelpers:helpers.length,entireIRIdentical:true,existingNodesAndAssetsIdentical:true,alignmentWarningsBefore:prior.report.warnings.filter(w=>w.code==='ALIGN_SELF').length,alignmentWarningsAfter:current.report.warnings.filter(w=>w.code==='ALIGN_SELF').length});
 }
 await writeFile('test-results/alignment-regression.json',JSON.stringify({baseline:'4304645',evidence,note:'Current converter tested directly. Only tagged transparent alignment helpers are excluded from source-tree equality; all non-alignment warnings are compared. Native Figma editing not executed.'},null,2));
});

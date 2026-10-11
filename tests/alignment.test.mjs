import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,access} from 'node:fs/promises';
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

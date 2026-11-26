import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('extension');
const server=createServer(async(req,res) => {
  try {
    const url=new URL(req.url,'http://localhost');
    const path=resolve(root,`.${url.pathname}`);
    if(!path.startsWith(root+'\\') && !path.startsWith(root+'/')) {res.writeHead(403);res.end();return;}
    res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css'})[extname(path)] || 'text/plain');
    res.end(await readFile(path));
  } catch {res.writeHead(404);res.end();}
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  // launch() creates an isolated temporary profile; never connect to a user's browser.
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route => route.request().url().startsWith(base) || route.request().url().startsWith('blob:') ? route.continue() : route.abort());
  await page.addInitScript(({base}) => {
    const tabs=Array.from({length:2000},(_,i)=>({id:i+1,windowId:1,index:i,url:`https://synthetic${i%20}.invalid/article/${i}`,title:`읽어볼 가상 자료 ${String(i).padStart(4,'0')}`,pinned:i%100===0,mutedInfo:{muted:i%13===0},cookieStoreId:'firefox-default',incognito:false,status:'complete'}));
    tabs.push({id:900001,windowId:1,index:2000,url:`${base}/manager.html`,title:'관리 화면',incognito:false,status:'complete'});
    const removed=[],created=[],updates=[];
    const api={runtime:{getURL:path=>`${base}/${path}`,onMessage:{addListener:()=>{}}},permissions:{contains:async()=>false,request:async()=>false},windows:{getCurrent:async()=>({id:1}),getAll:async()=>[{id:1,type:'normal',incognito:false}]},tabs:{query:async()=>structuredClone(tabs),get:async id=>structuredClone(tabs.find(t=>t.id===id)),remove:async id=>{removed.push(id);tabs.splice(tabs.findIndex(t=>t.id===id),1);},create:async props=>{created.push(props);const tab={...props,id:1000000+created.length};tabs.push(tab);return tab;},update:async(id,props)=>{updates.push(props);Object.assign(tabs.find(t=>t.id===id),props);}}};
    let service;
    const ready=async()=>{ if(!service) {const [{VaultService},{VaultDB}]=await Promise.all([import(`${base}/service.js`),import(`${base}/db.js`)]);service=new VaultService(new VaultDB('browser-test'),api);} return service;};
    api.runtime.sendMessage=async ({action,args})=>{const s=await ready();return s.run(async()=>{try{return {ok:true,result:await s[action](args)}}catch(e){return {ok:false,error:e.message}}});};
    window.browser=api; window.mock={tabs,removed,created,updates,ready};
  },{base});
  await page.goto(`${base}/manager.html`);
  try { await page.waitForFunction(()=>document.getElementById('message').textContent==='로컬 보관함 준비 완료.',null,{timeout:10000}); }
  catch { throw new Error(`Manager initialization did not finish. message=${await page.textContent('#message')} pageErrors=${errors.join(' | ')}`); }
  const start=performance.now(); await page.click('#save');
  await page.waitForFunction(()=>document.querySelectorAll('.item').length===50 && !document.getElementById('backup-now').disabled);
  const saveMs=performance.now()-start;
  assert.equal(await page.locator('.item').count(),50);
  assert.equal(await page.locator('#close-tabs').isDisabled(),true);
  const downloadPromise=page.waitForEvent('download'); await page.click('#backup-now'); const download=await downloadPromise;
  const data=await readFile(await download.path()); assert.equal(JSON.parse(data).items.length,2000);
  await page.setInputFiles('#verify-file',{name:'synthetic-backup.json',mimeType:'application/json',buffer:data});
  await page.waitForFunction(()=>!document.getElementById('ack').disabled);
  await page.check('#ack');
  await page.screenshot({path:'test-results/manager-desktop.png',fullPage:false});
  page.once('dialog',dialog=>dialog.accept('닫기 2000'));
  await page.click('#close-tabs'); await page.waitForFunction(()=>window.mock.removed.length===2000);
  await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  assert.equal(await page.evaluate(()=>window.mock.tabs.length),1);
  await page.locator('.item').first().getByRole('button',{name:'백그라운드로 하나 열기',exact:true}).click();
  await page.waitForFunction(()=>window.mock.created.length===1 && !document.getElementById('refresh').disabled);
  assert.equal(await page.evaluate(()=>window.mock.updates[0].active),false);
  await page.locator('.item').first().getByRole('button',{name:'메모 / 태그'}).click();
  await page.fill('#note','테스트 메모'); await page.fill('#tags','가상, 확인'); await page.locator('#edit-form button[type=submit]').click();
  await page.waitForFunction(()=>!document.getElementById('edit-dialog').open);
  await page.locator('.item').first().getByRole('button',{name:'완료',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.item select').value==='done');
  await page.locator('.item').first().getByRole('button',{name:'삭제',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  await page.check('#trash'); await page.waitForFunction(()=>document.querySelectorAll('.item').length===1);
  await page.getByRole('button',{name:'휴지통에서 복원',exact:true}).click(); await page.waitForFunction(()=>document.querySelectorAll('.item').length===0);
  await page.uncheck('#trash'); await page.waitForFunction(()=>document.querySelectorAll('.item').length===50);
  await page.fill('#search','article/1999'); await page.waitForFunction(()=>document.querySelectorAll('.item').length===1);
  assert.match(await page.textContent('.item'),/1999/);
  await page.fill('#search',''); await page.waitForFunction(()=>document.querySelectorAll('.item').length===50);
  await page.click('#next'); await page.waitForFunction(()=>document.getElementById('page-info').textContent.startsWith('2 /'));
  const perf=await page.evaluate(async()=>{
    const s=await window.mock.ready(); const {renderList}=await import('./view.js'); const samples=[];
    for(let i=1;i<=40;i++){const start=performance.now();const result=await s.list({page:i,sort:'domain'});renderList(document,document.getElementById('list'),result.items,{selected:new Set(),onAction:()=>{},onSelect:()=>{}});await new Promise(requestAnimationFrame);samples.push(performance.now()-start);if(document.querySelectorAll('.item').length>50)throw Error('DOM overflow');}
    return {pages:samples.length,medianMs:samples.sort((a,b)=>a-b)[20],maxMs:Math.max(...samples),rows:document.querySelectorAll('.item').length};
  });
  assert.ok(perf.maxMs<1500); assert.equal(perf.rows,50);
  await page.click('#refresh'); await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  await page.setViewportSize({width:600,height:950}); await page.screenshot({path:'test-results/manager-narrow.png',fullPage:false});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  // Reload page to prove durable IndexedDB content survives the UI's lifetime.
  await page.reload(); await page.waitForFunction(()=>document.querySelectorAll('.item').length===50);
  assert.match(await page.textContent('#counts'),/2,000/); assert.equal(await page.locator('#close-tabs').isDisabled(),true);
  assert.deepEqual(errors,[]);
  await page.goto(`${base}/sidebar.html`);
  await page.setViewportSize({width:360,height:900});
  await page.waitForFunction(()=>document.querySelectorAll('.side-item').length===50 && !document.getElementById('refresh').disabled);
  for(const selector of ['.side-filters','.side-tools','.side-notice','.quick-actions'])assert.equal(await page.locator(selector).evaluateAll(elements=>elements.every(element=>getComputedStyle(element).display==='none')),true);
  await page.locator('.side-title').first().click();
  await page.waitForFunction(()=>window.mock.created.length===1 && !document.getElementById('refresh').disabled);
  assert.equal(await page.evaluate(()=>window.mock.updates[0].active),true);
  await page.locator('.side-title').nth(1).dispatchEvent('auxclick',{button:1});
  await page.waitForFunction(()=>window.mock.created.length===2 && !document.getElementById('refresh').disabled);
  assert.equal(await page.evaluate(()=>window.mock.updates[1].active),false);
  await page.screenshot({path:'test-results/sidebar-360.png'});
  for(const width of [280,360,420]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.setViewportSize({width:360,height:900});
  await page.click('#next');await page.waitForFunction(()=>document.getElementById('page-info').textContent.startsWith('2 /'));
  await page.click('#open-manager');await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  assert.equal(await page.evaluate(()=>window.mock.created.length),2); // Existing manager reused, no extra tab.
  assert.equal(await page.isChecked('#sync-toggle'),false);
  await page.locator('.sync-label').click();await page.waitForFunction(()=>document.getElementById('sync-toggle').checked && !document.getElementById('refresh').disabled);
  const auto=await page.evaluate(async()=>{
    const s=await window.mock.ready();const {items}=await s.db.snapshot();const target={...items.find(i=>i.status==='unread'&&i.deletedAt===null),id:crypto.randomUUID(),url:'https://unique-autosync.invalid/test-only',status:'unread',deletedAt:null};await s.db.commit({items:[target]});
    for(const id of [3000001,3000002]){const tab={id,windowId:1,url:target.url,incognito:false};window.mock.tabs.push(tab);await s.onTabCreated(tab);}
    window.mock.tabs.splice(window.mock.tabs.findIndex(t=>t.id===3000001),1);const first=await s.onTabRemoved(3000001,{});
    const middle=(await s.db.snapshot()).items.find(i=>i.id===target.id).status;
    window.mock.tabs.splice(window.mock.tabs.findIndex(t=>t.id===3000002),1);const last=await s.onTabRemoved(3000002,{});
    return {target:target.id,first,middle,last,status:(await s.db.snapshot()).items.find(i=>i.id===target.id).status};
  });
  assert.equal(auto.first.changed,0,JSON.stringify(auto));assert.equal(auto.middle,'unread',JSON.stringify(auto));assert.equal(auto.last.changed,1,JSON.stringify(auto));assert.equal(auto.status,'done',JSON.stringify(auto));
  await page.locator('.sync-label').click();await page.waitForFunction(()=>!document.getElementById('sync-toggle').checked && !document.getElementById('refresh').disabled);
  assert.deepEqual(errors,[]);
  const report={engine:'Isolated headless Edge / Chromium; simulated browser.tabs, real IndexedDB and DOM',syntheticTabs:2000,saveAndFirstRenderMs:Math.round(saveMs),...perf,flow:'save -> verify -> JSON download -> file verification -> explicit close -> one background open -> note/tags -> done -> trash -> restore -> search -> pagination -> UI reload',pageErrors:errors};
  report.sidebar='360px tab-only title open/middle-click background open/pagination/manager reuse; sync toggle; 280/360/420px no horizontal overflow; 50 DOM rows';
  report.sync='Toggle persists; closing one of two matching tabs does not complete; closing the last match marks its item done';
  await writeFile('test-results/browser-report.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
} finally {await browser?.close();server.close();}

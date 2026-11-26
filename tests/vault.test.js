import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { VaultDB } from '../extension/db.js';
import { VaultService } from '../extension/service.js';
import { queryItems, readableExport, validateBackup } from '../extension/model.js';

function fixture(n = 10, options = {}) {
  let nextId = n + 100;
  const removed = [], created = [], updates = [];
  const tabs = Array.from({length:n},(_,i) => ({ id:i+1,windowId:i%2+1,index:Math.floor(i/2),url:`https://example${i%25}.invalid/page/${options.duplicates ? Math.floor(i/2) : i}`,title:`가상 탭 ${i}`,pinned:i%10===0,mutedInfo:{muted:i%7===0},cookieStoreId:'firefox-default',incognito:false,status:'complete' }));
  if (options.duplicates) for(let i=1;i<n;i+=2) tabs[i].url=tabs[i-1].url;
  tabs.push({id:900001,windowId:1,index:99999,url:'moz-extension://test/ui/manager.html',title:'관리 화면',incognito:false});
  tabs.push({id:900002,windowId:3,index:0,url:'https://private.invalid',title:'비공개',incognito:true});
  tabs.push({id:900003,windowId:4,index:0,url:'https://popup.invalid',title:'팝업',incognito:false});
  const api = {
    runtime:{getURL:path => `moz-extension://test/${path}`},
    windows:{getAll:async() => [{id:1,type:'normal',incognito:false},{id:2,type:'normal',incognito:false},{id:3,type:'normal',incognito:true},{id:4,type:'popup',incognito:false}]},
    permissions:{contains:async() => false},
    tabs:{
      query:async() => structuredClone(tabs),
      get:async id => {const t=tabs.find(t=>t.id===id); if(!t)throw Error('missing'); return structuredClone(t);},
      remove:async id => { removed.push(id); tabs.splice(tabs.findIndex(t=>t.id===id),1); },
      create:async props => {created.push(props); const t={...props,id:nextId++}; tabs.push(t); return t;},
      update:async(id,props) => {updates.push({id,...props}); Object.assign(tabs.find(t=>t.id===id),props);}
    }
  };
  const db=new VaultDB(`test-${crypto.randomUUID()}`); const service=new VaultService(db,api);
  return {db,service,api,tabs,removed,created,updates};
}
async function save(f,dedupe=true) { const p=await f.service.preview({scope:'all',windowId:1,dedupe}); const job=await f.service.save({previewId:p.id}); return {p,job}; }

test('about tabs excluded in both scopes; old archive survives; about-only cannot save',async()=>{
  const f=fixture(4);await f.service.ready;
  f.tabs[0].url='about:config';f.tabs[1].url='ABOUT:blank';
  assert.equal((await f.service.capture({scope:'current',windowId:1,dedupe:true})).captured,1);
  assert.equal((await f.service.capture({scope:'all',windowId:1,dedupe:true})).captured,2);
  const old={...(await f.db.snapshot()).items[0],id:'old-about',url:'about:config'};
  await f.db.commit({items:[old]});
  await f.service.capture({scope:'all',windowId:1,dedupe:true});
  assert.ok((await f.db.snapshot()).items.some(i=>i.id==='old-about'));
  for(const tab of f.tabs)if(tab.id<100)tab.url='about:blank';
  await assert.rejects(f.service.capture({scope:'all',windowId:1,dedupe:true}),/대상/);
  assert.equal(f.removed.length,0);
});

test('reviewing reflects live normal tabs, not history, and preserves done and trash',async()=>{
  const f=fixture(3);await f.service.ready;await save(f);
  assert.equal((await f.service.list({status:'reviewing'})).total,3);
  const target=(await f.db.snapshot()).items.find(i=>i.url===f.tabs[0].url);
  await f.service.openOne({id:target.id,windowId:1,active:false});
  for(let n=f.tabs.length-1;n>=0;n--)if(f.tabs[n].url===target.url)f.tabs.splice(n,1);
  assert.equal((await f.service.list({status:'unread'})).total,1);
  f.tabs.push({id:3001,windowId:3,url:target.url,incognito:true},{id:3002,windowId:4,url:target.url});
  assert.equal((await f.service.list({status:'unread'})).total,1);
  f.tabs.push({id:3003,windowId:2,url:target.url});
  assert.equal((await f.service.list({status:'reviewing'})).total,3);
  f.tabs.at(-1).url='https://navigated.invalid';
  const restarted=new VaultService(f.db,f.api);await restarted.ready;
  assert.equal((await restarted.list({status:'unread'})).total,1);
  await restarted.mutate({ids:[target.id],action:'status',status:'done'});
  f.tabs.at(-1).url=target.url;
  assert.equal((await restarted.list({status:'done'})).total,1);
  await restarted.mutate({ids:[target.id],action:'delete'});
  assert.equal((await restarted.list({trash:true})).items[0].status,'done');
});

test('duplicate close failures and navigations stop completion and next open',async()=>{
  for(const kind of ['failure','navigation']){
    const f=fixture(4,{duplicates:true});await f.service.ready;await save(f);await f.service.setAutoSync({enabled:true});
    const url=f.tabs[0].url;f.tabs.splice(0,1);
    if(kind==='failure')f.api.tabs.remove=async()=>{throw Error('simulated failure');};
    else {const get=f.api.tabs.get;f.api.tabs.get=async id=>({...await get(id),url:'https://changed.invalid'});}
    const event=await f.service.onTabRemoved(1,{});
    assert.equal(event.closeFailed,true);assert.equal(f.created.length,0);
    assert.ok((await f.db.snapshot()).items.filter(i=>i.url===url).every(i=>i.status!=='done'));
  }
});

test('workflow ignores private duplicates and opens above at end only once',async()=>{
  const f=fixture(2);await f.service.ready;await save(f);await f.service.setAutoSync({enabled:true});
  const target=f.tabs.find(t=>t.id===2);
  f.tabs.push({...target,id:4000,windowId:3,incognito:true});
  f.tabs.splice(f.tabs.findIndex(t=>t.id===2),1);
  const result=await f.service.onTabRemoved(2,{});
  assert.equal(result.changed,1);assert.equal(f.created.length,1);
  assert.ok(f.tabs.some(t=>t.id===4000));
  assert.equal(f.updates.at(-1).url,f.tabs.find(t=>t.id===1).url);
  assert.equal((await f.service.onTabRemoved(2,{})).changed,0);
  assert.equal(f.created.length,1);
});

test('bulk unread preserves content and clears completion time',async()=>{
  const f=fixture(3);await f.service.ready;await save(f);
  const ids=(await f.db.snapshot()).items.map(i=>i.id);
  await f.service.mutate({ids,action:'status',status:'done'});
  await f.service.mutate({ids,action:'status',status:'unread'});
  const items=(await f.db.snapshot()).items;
  assert.equal(items.length,3);
  assert.ok(items.every(i=>i.status==='unread' && i.completedAt===null));
  assert.equal(f.removed.length,0);
});

test('empty trash confirms exact snapshot, removes references atomically, permits saving again',async()=>{
  const f=fixture(3);await f.service.ready;await save(f);
  const items=(await f.db.snapshot()).items;
  await f.service.mutate({ids:[items[0].id],action:'delete'});
  const stale=await f.service.prepareEmptyTrash();
  await assert.rejects(f.service.emptyTrash({...stale,confirmed:false}));
  await assert.rejects(f.service.emptyTrash(stale));
  await f.service.mutate({ids:[items[1].id],action:'delete'});
  await assert.rejects(f.service.emptyTrash({...stale,confirmed:true}));
  const prepared=await f.service.prepareEmptyTrash();
  const backup=await f.service.exportJSON();
  assert.equal((await f.service.emptyTrash({...prepared,confirmed:true})).removed,2);
  const state=await f.db.snapshot();
  assert.equal(state.items.length,1);assert.equal(state.items[0].id,items[2].id);
  assert.ok(state.checkpoints.every(c=>!prepared.ids.includes(c.itemId)));
  assert.equal(state.jobs.length,0);assert.equal(f.removed.length,0);
  assert.equal(backup.items.length,3);
  await save(f);assert.equal((await f.db.snapshot()).items.length,3);
});

test('permanent delete transaction abort restores removed items',async()=>{
  const f=fixture(2);await f.service.ready;await save(f);
  const before=await f.db.snapshot();
  await assert.rejects(f.db.commit({items:[{}]},{items:before.items.map(i=>i.id)}));
  assert.deepEqual((await f.db.snapshot()).items,before.items);
});

test('one-click capture verifies 2,000 sources, merges duplicates, repeats safely without closing',async()=>{
  const f=fixture(2000,{duplicates:true}); await f.service.ready;
  const args={scope:'all',windowId:1,dedupe:true};
  const job=await f.service.run(()=>f.service.capture(args));
  assert.equal(job.captured,2000); assert.equal(job.created,1000);
  assert.equal(job.verified,true);
  const repeated=await f.service.run(()=>f.service.capture(args));
  assert.equal(repeated.created,0);
  assert.equal((await f.db.snapshot()).items.length,1000);
  assert.equal(f.removed.length,0); assert.equal(f.created.length,0);
});

test('2,000-tab full lifecycle: atomic save, readback, backup, close, one open, done, trash, restore, import',async t => {
  const f=fixture(2000); const start=performance.now(); const {p,job}=await save(f);
  assert.equal(p.count,2000); assert.equal(job.captured,2000); assert.equal(job.created,2000); assert.equal(f.removed.length,0);
  const data=await f.service.exportJSON(); assert.equal(data.items.length,2000); validateBackup(data);
  const closed=await f.service.closeJob({jobId:job.id}); assert.equal(closed.closed,2000);
  assert.equal(f.created.length,1,'창 2의 탭이 모두 닫혀 빈 새 탭 1개'); assert.equal(f.created[0].windowId,2);
  assert.equal(f.tabs.length,4);
  const id=data.items[0].id; await f.service.openOne({id,active:false,windowId:1}); assert.equal(f.created.length,2); assert.equal(f.updates[0].active,false);
  let state=await f.db.snapshot(); assert.equal(state.items.find(i=>i.id===id).status,'reviewing'); assert.equal(state.items.length,2000);
  await f.service.mutate({ids:[id],action:'edit',note:'확인할 자료',tags:['읽기','자료']});
  await f.service.mutate({ids:[id],action:'status',status:'done'});
  assert.ok(Number.isFinite((await f.db.snapshot()).items.find(i=>i.id===id).completedAt));
  await f.service.mutate({ids:[id],action:'delete'}); assert.equal((await f.service.list({trash:true})).total,1);
  await f.service.mutate({ids:[id],action:'restore'}); assert.equal((await f.service.list({status:'done'})).total,1);
  const restored=fixture(0); const backup=await f.service.exportJSON(); assert.equal((await restored.service.importJSON({data:backup})).added,2000);
  assert.equal((await restored.service.importJSON({data:backup})).skipped,2000); assert.equal((await restored.db.snapshot()).jobs.length,0);
  const i=(await restored.db.snapshot()).items.find(i=>i.id===id); assert.equal(i.note,'확인할 자료'); assert.deepEqual(i.tags,['읽기','자료']); assert.equal(i.status,'done');
  t.diagnostic(`2,000-tab simulated lifecycle: ${(performance.now()-start).toFixed(0)} ms`);
});
test('2,000 items: paginate at 50 rows, search and all sorts (screens render with Vue, no raw HTML)',async t => {
  const f=fixture(2000); await save(f); const {items}=await f.db.snapshot();
  const start=performance.now();
  for(const sort of ['order','domain','title','recent','newest']) { const r=queryItems(items,{sort,page:1}); assert.equal(r.items.length,50); assert.equal(r.pages,40); }
  for(let page=1;page<=40;page++) assert.equal(queryItems(items,{page}).items.length,50);
  assert.equal(queryItems(items,{search:'page/1999'}).total,1); assert.equal(queryItems(items,{search:'가상 탭 1999'}).total,1);
  assert.equal(queryItems(items,{page:999}).page,40);
  t.diagnostic(`2,000-item query paging: ${Math.round(performance.now()-start)} ms`);
});
test('current window excludes private, popup and own pages; exact URL duplicate toggle',async() => {
  const f=fixture(10,{duplicates:true}); const current=await f.service.preview({scope:'current',windowId:1,dedupe:true}); assert.equal(current.count,5);
  const {p,job}=await save(f); assert.equal(p.duplicate,5); assert.equal(job.created,5); assert.equal(job.captured,10);
  const g=fixture(10,{duplicates:true}); const result=await save(g,false); assert.equal(result.job.created,10);
  const again=await save(g,false); assert.equal(again.job.reused,true); assert.equal((await g.db.snapshot()).jobs.length,1);
});
test('checkpoint reuses the same tab when scope or snapshot order changes',async() => {
  const f=fixture(); await save(f,false); f.tabs[0].index=50; await save(f,false); assert.equal((await f.db.snapshot()).items.length,10);
  const p=await f.service.preview({scope:'current',windowId:1,dedupe:false}); await f.service.save({previewId:p.id}); assert.equal((await f.db.snapshot()).items.length,10);
});
test('preview change and missing metadata block saving',async() => {
  const f=fixture(); const p=await f.service.preview({scope:'all',windowId:1}); f.tabs[0].url='https://changed.invalid';
  await assert.rejects(f.service.save({previewId:p.id}),/미리보기/); assert.equal((await f.db.snapshot()).items.length,0);
  delete f.tabs[0].title; await assert.rejects(save(f),/누락/); f.tabs[0].title='fixed'; assert.equal(f.removed.length,0);
});
test('transaction abort rolls back all stores',async() => {
  const f=fixture(); await assert.rejects(f.db.commit({items:[{id:'first'},{missingKey:true}],jobs:[{id:'job'}]}),/트랜잭션/);
  const state=await f.db.snapshot(); assert.equal(state.items.length,0); assert.equal(state.jobs.length,0); assert.equal(f.removed.length,0);
});
test('write failure and partial readback never authorize close',async() => {
  const f=fixture(); f.db.commit=async() => {throw Error('simulated disk failure');}; await assert.rejects(save(f)); assert.equal(f.removed.length,0);
  const g=fixture(); const commit=g.db.commit.bind(g.db); g.db.commit=changes => commit({...changes,items:changes.items.slice(1)}); await assert.rejects(save(g),/일부/); assert.equal(g.removed.length,0);
});
test('single tab preserves pinned/muted, requires container opt-in, done is never auto-reset',async() => {
  const f=fixture(); f.tabs[0].cookieStoreId='firefox-container-1'; await save(f); const i=(await f.db.snapshot()).items.find(i=>i.sources[0].tabId===1);
  await assert.rejects(f.service.openOne({id:i.id,windowId:1,active:true}),/권한/); assert.equal(f.created.length,0);
  f.api.permissions.contains=async()=>true; await f.service.openOne({id:i.id,windowId:1,active:false}); assert.equal(f.created[0].cookieStoreId,'firefox-container-1'); assert.equal(f.created[0].pinned,true); assert.equal(f.updates[0].muted,true);
  await f.service.mutate({ids:[i.id],action:'status',status:'done'}); await f.service.openOne({id:i.id,windowId:1,active:true}); assert.equal((await f.db.snapshot()).items.find(x=>x.id===i.id).status,'done');
});
test('bulk transactions, import validation, repeated import and trash roundtrip',async() => {
  const f=fixture(); await save(f); const ids=(await f.db.snapshot()).items.map(i=>i.id);
  await f.service.mutate({ids,action:'status',status:'done'}); await f.service.mutate({ids,action:'delete'}); const backup=await f.service.exportJSON();
  const g=fixture(0); await g.service.importJSON({data:backup}); assert.equal((await g.service.list({trash:true})).total,10);
  await g.service.mutate({ids,action:'restore'}); assert.equal((await g.service.list({status:'done'})).total,10);
  const bad=structuredClone(backup); bad.items[0].status='__proto__'; await assert.rejects(g.service.importJSON({data:bad})); assert.equal((await g.db.snapshot()).items.length,10);
  const invalid=structuredClone(backup); invalid.items.push(invalid.items[0]); await assert.rejects(g.service.importJSON({data:invalid}));
});
test('HTML/TXT escaping, dangerous URL is text only; no external content embedded',async() => {
  const f=fixture(1); await save(f); const {items}=await f.db.snapshot(); items[0].url='javascript:alert(1)'; items[0].title='<script>bad()</script>';
  const html=readableExport(items,true); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('href="javascript:')); assert.ok(!html.includes('<script>')); assert.ok(readableExport(items).includes('javascript:alert(1)'));
});
test('service queue serializes overlapping saves and updates',async() => {
  const f=fixture(); const p=await f.service.preview({scope:'all',windowId:1,dedupe:false});
  await Promise.all([f.service.run(()=>f.service.save({previewId:p.id})),f.service.run(()=>f.service.save({previewId:p.id}))]);
  assert.equal((await f.db.snapshot()).items.length,10); assert.equal((await f.db.snapshot()).jobs.length,1);
});
test('auto-sync off, URL match, duplicate tabs, private/restricted tabs, window close and trash are safe',async()=>{
  const f=fixture(10);f.tabs[0].url='https://www.a.com/article';const {job}=await save(f);const target=(await f.db.snapshot()).items.find(i=>i.url==='https://www.a.com/article');
  assert.equal((await f.service.autoSyncState()).enabled,false);
  await f.service.onTabRemoved(1,{});assert.equal((await f.db.snapshot()).items.find(i=>i.id===target.id).status,'unread');
  await f.service.setAutoSync({enabled:true});
  f.tabs.push({id:2001,windowId:1,url:target.url,incognito:false});await f.service.onTabCreated(f.tabs.at(-1));
  f.tabs.splice(f.tabs.findIndex(t=>t.id===2001),1);await f.service.onTabRemoved(2001,{});
  assert.ok(f.removed.includes(1),'duplicate tab closes automatically');
  await f.service.onTabRemoved(1,{});
  assert.equal((await f.db.snapshot()).items.find(i=>i.id===target.id).status,'done');
  const others=(await f.db.snapshot()).items.find(i=>i.url==='https://example1.invalid/page/1');
  f.tabs.push({id:2002,windowId:1,url:others.url,incognito:false});await f.service.onTabCreated(f.tabs.at(-1));
  f.tabs.splice(f.tabs.findIndex(t=>t.id===2002),1);await f.service.onTabRemoved(2002,{isWindowClosing:true});
  assert.equal((await f.db.snapshot()).items.find(i=>i.id===others.id).status,'unread','closing a whole window is ignored');
  const g=fixture(2);g.tabs[0].url='about:config';const {job:restrictedJob}=await save(g);await g.service.setAutoSync({enabled:true});
  g.tabs.splice(g.tabs.findIndex(t=>t.id===1),1);await g.service.onTabRemoved(1,{});
  assert.ok(!(await g.db.snapshot()).items.some(i=>i.url==='about:config'));
  const restarted=new VaultService(f.db,f.api);await restarted.ready;assert.equal((await restarted.autoSyncState()).enabled,false,'workflow never resumes after restart');
  await restarted.setAutoSync({enabled:false});f.tabs.splice(f.tabs.findIndex(t=>t.id===2),1);await restarted.onTabRemoved(2,{});
  assert.equal((await f.db.snapshot()).items.find(i=>i.url==='https://example1.invalid/page/1').status,'unread');
});
test('workflow closes duplicate URLs, timestamps completion, then opens exactly one next item',async()=>{
  const f=fixture(8,{duplicates:true}); await save(f,false); await f.service.setAutoSync({enabled:true});
  const firstUrl=f.tabs.find(t=>t.id===1).url; const matchIds=f.tabs.filter(t=>t.url===firstUrl).map(t=>t.id);
  f.tabs.splice(f.tabs.findIndex(t=>t.id===matchIds[0]),1);let event=await f.service.onTabRemoved(matchIds[0],{});
  assert.ok(f.removed.includes(matchIds[1]));
  const repeated=await f.service.onTabRemoved(matchIds[1],{});assert.equal(repeated.changed,0);
  const state=await f.db.snapshot();const duplicates=state.items.filter(i=>i.url===firstUrl);
  assert.equal(event.changed,duplicates.length);assert.ok(duplicates.every(i=>i.status==='done'&&Number.isFinite(i.completedAt)));
  assert.equal(f.created.length,1,'only one next page opened');assert.equal(f.updates.at(-1).active,true);
  const ordered=[...state.items].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));const lastDone=Math.max(...ordered.map((i,n)=>i.url===firstUrl&&i.status==='done'?n:-1));
  const next=ordered.find((i,n)=>n>lastDone&&i.deletedAt===null&&i.status!=='done');assert.equal(f.updates.at(-1).url,next.url,'opens the next saved-order item');assert.equal(next.status,'reviewing');
});
test('IndexedDB v1 archive survives v3 workflow migration',async()=>{
  const name=`migration-${crypto.randomUUID()}`;
  await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>{for(const store of ['items','jobs','checkpoints'])request.result.createObjectStore(store,{keyPath:'id'});};request.onsuccess=()=>{const db=request.result;const tx=db.transaction('items','readwrite');tx.objectStore('items').put({id:'old-archive',url:'https://old.invalid',title:'Preserved',status:'unread',note:'',tags:[],createdAt:1,updatedAt:1,lastViewedAt:null,deletedAt:null,warning:false,sources:[]});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};request.onerror=()=>reject(request.error);});
  const db=new VaultDB(name);let state=await db.snapshot();assert.equal(state.items[0].id,'old-archive');assert.ok(state.settings.some(s=>s.id==='workflow'&&!s.enabled));assert.deepEqual(state.workTabs,[]);
  await db.commit({settings:[{id:'auto-sync',enabled:true}]});state=await db.snapshot();assert.equal(state.items[0].title,'Preserved');assert.equal(state.settings[0].enabled,true);db.db.close();
});
test('theme preference persists in local IndexedDB',async()=>{
  const f=fixture(1);assert.equal((await f.service.themeState()).settings,'system');await f.service.setTheme({theme:'dark'});assert.equal((await new VaultService(f.db,f.api).themeState()).settings,'dark');await f.service.setTheme({theme:'system'});assert.equal((await f.service.themeState()).settings,'system');
});
test('active sidebar filter separates completed entries',async()=>{
  const f=fixture(3);await save(f);const {items}=await f.db.snapshot();await f.service.mutate({ids:[items[0].id],action:'status',status:'done'});
  assert.equal((await f.service.list({status:'active'})).total,2);assert.equal((await f.service.list({status:'done'})).total,1);assert.equal((await f.service.list({})).total,3);
});

const supjavPosts = [
  { id: '300', url: 'https://supjav.com/ja/300.html', title: '新しい', thumb: 'https://img.supjav.com/images/a.jpg', date: '2026-11-25' },
  { id: '100', url: 'https://supjav.com/ja/100.html', title: '古い', thumb: null, date: '2026-11-23' },
  { id: '200', url: 'https://supjav.com/ja/200.html', title: '中間', thumb: null, date: '2026-11-24' }
];

test('supjav posts keep the page reading order: newest sort matches top-left to bottom-right, skip existing URLs', async () => {
  const f = fixture(0); await f.service.ready;
  const first = await f.service.addCollected({ posts: supjavPosts });
  assert.deepEqual(first, { added: 3, skipped: 0, verified: 3 });
  const { items } = await f.db.snapshot();
  const bySaved = [...items].sort((a, b) => a.createdAt - b.createdAt);
  assert.deepEqual(bySaved.map(i => i.supjav.id), ['200', '100', '300']);
  assert.ok(items.every(i => i.status === 'unread' && i.tags[0] === 'supjav' && i.sources.length === 0 && !i.warning));
  const newest = await f.service.list({ sort: 'newest', status: 'active' });
  assert.deepEqual(newest.items.map(i => i.title), ['新しい', '古い', '中間']);
  await f.service.mutate({ ids: [bySaved[0].id], action: 'delete' });
  const again = await f.service.addCollected({ posts: [...supjavPosts, { id: '400', url: 'https://supjav.com/ja/400.html', title: '最新', date: '2026-11-26' }, { id: '9', url: 'https://evil.invalid/9.html', title: 'x' }] });
  assert.deepEqual(again, { added: 1, skipped: 3, verified: 4 }, 'existing (even trashed) URLs are not re-added; foreign URLs ignored');
  const top = await f.service.list({ sort: 'newest', status: 'active' });
  assert.equal(top.items[0].title, '最新');
  validateBackup(JSON.parse(JSON.stringify(await f.service.exportJSON())));
});

test('with newest order the workflow moves down the screen to the older item', async () => {
  for (const [order, expected] of [['newest', '200'], ['oldest', '300']]) {
    const f = fixture(0); await f.service.ready;
    await f.service.addCollected({ posts: supjavPosts });
    f.tabs.push({ id: 5000, windowId: 1, index: 0, url: 'https://supjav.com/ja/100.html', title: '古い', pinned: false, mutedInfo: { muted: false }, cookieStoreId: null, status: 'complete' });
    await f.service.setWorkOrder({ order });
    await f.service.setAutoSync({ enabled: true });
    f.tabs.splice(f.tabs.findIndex(t => t.id === 5000), 1);
    const event = await f.service.onTabRemoved(5000, {});
    assert.equal(event.changed, 1);
    const opened = [...f.created, ...f.updates].map(x => x.url).filter(u => u && u !== 'about:blank');
    assert.deepEqual(opened, [`https://supjav.com/ja/${expected}.html`], order);
  }
  await assert.rejects(fixture(0).service.setWorkOrder({ order: 'sideways' }));
});

test('source filter keeps supjav-tagged or supjav.com items only', () => {
  const it = (id, url, tags = []) => ({ id, url, title: id, status: 'unread', note: '', tags, createdAt: 1, deletedAt: null });
  const items = [it('a', 'https://supjav.com/ja/1.html'), it('b', 'https://x.test/', ['supjav']), it('c', 'https://x.test/2')];
  assert.deepEqual(queryItems(items, { source: 'supjav' }).items.map(i => i.id).sort(), ['a', 'b']);
  assert.equal(queryItems(items, {}).total, 3);
});

test('auto close: capture saves and verifies locally, closeJob closes verified tabs and skips loading, internal and supjav list tabs',async()=>{
  const f=fixture(6); await f.service.ready;
  f.tabs[0].url='about:config'; f.tabs[1].url='moz-extension://other/page.html'; f.tabs[2].url='https://supjav.com/ja/category/uncensored-jav/page/2'; f.tabs[3].status='loading';
  const r=await f.service.capture({scope:'all',windowId:1});
  assert.equal(r.captured,2); assert.equal(r.loading,1); assert.equal(r.verified,true);
  assert.deepEqual((await f.db.snapshot()).items.map(i=>i.url).sort(),[f.tabs[4].url,f.tabs[5].url].sort());
  assert.equal(f.removed.length,0,'저장만으로는 닫지 않음');
  const c=await f.service.closeJob({jobId:r.id}); assert.equal(c.closed,2); assert.deepEqual(f.removed.sort(),[5,6]);
  assert.ok(f.tabs.some(t=>t.id===1)&&f.tabs.some(t=>t.id===3)&&f.tabs.some(t=>t.id===4));
});
test('auto close keeps changed tabs open and refuses jobs from another run or with broken local data',async()=>{
  for(const kind of ['url','epoch']){
    const f=fixture(4); const r=await f.service.capture({scope:'all',windowId:1});
    if(kind==='url')f.tabs[0].url='https://changed.invalid'; else f.service.changed(f.tabs[0].id);
    const c=await f.service.closeJob({jobId:r.id}); assert.equal(c.closed,3); assert.equal(c.kept,1); assert.ok(f.tabs.some(t=>t.id===1));
  }
  const f=fixture(4); const r=await f.service.capture({scope:'all',windowId:1});
  await assert.rejects(new VaultService(f.db,f.api).closeJob({jobId:r.id}),/실행/);
  await f.service.mutate({ids:[(await f.db.snapshot()).items[0].id],action:'delete'});
  await assert.rejects(f.service.closeJob({jobId:r.id})); assert.equal(f.removed.length,0);
});
test('auto close opens a blank tab first when a window would lose all its tabs, and never triggers the workflow',async()=>{
  const f=fixture(2); f.tabs.splice(f.tabs.findIndex(t=>t.id===900001),1);
  const r=await f.service.capture({scope:'current',windowId:1}); await f.service.setAutoSync({enabled:true});
  const c=await f.service.closeJob({jobId:r.id}); assert.equal(c.closed,1);
  assert.equal(f.created.length,1); assert.equal(f.created[0].windowId,1); assert.ok(!f.created[0].url,'빈 새 탭');
  const e=await f.service.onTabRemoved(1,{}); assert.equal(e.changed||0,0,'자동 닫기는 완료 처리 안 함');
  assert.equal((await f.db.snapshot()).items[0].status,'unread');
});
test('tidy closes only tabs already in the vault (not trash), saves nothing new, and re-checks the DB before closing',async()=>{
  const f=fixture(4); await f.service.ready;
  const saved=await f.service.capture({scope:'all',windowId:1}); // 1~4 저장(닫지 않음)
  f.tabs.push({id:50,windowId:1,index:50,url:'https://new.invalid/',title:'새 탭',pinned:false,mutedInfo:{muted:false},cookieStoreId:'firefox-default',incognito:false,status:'complete'});
  const trashed=(await f.db.snapshot()).items.find(i=>i.url===f.tabs[1].url); await f.service.mutate({ids:[trashed.id],action:'delete'});
  const before=(await f.db.snapshot()).items.length;
  const plan=await f.service.tidyPrepare({scope:'all',windowId:1}); assert.equal(plan.count,3,'휴지통·새 주소 제외');
  const gone=(await f.db.snapshot()).items.find(i=>i.url===f.tabs[2].url); await f.service.mutate({ids:[gone.id],action:'delete'}); // 계획 뒤 휴지통 → 닫지 않음
  const r=await f.service.tidyClose({id:plan.id}); assert.equal(r.closed,2); assert.equal(r.kept,1);
  assert.equal((await f.db.snapshot()).items.length,before,'새로 저장한 것 없음');
  assert.ok(f.tabs.some(t=>t.id===50)&&f.tabs.some(t=>t.id===2)&&f.tabs.some(t=>t.id===3));
  await assert.rejects(f.service.tidyClose({id:plan.id}),/만료/);
  assert.ok(saved.verified);
});

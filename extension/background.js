import { VaultDB } from './db.js';
import { VaultService } from './service.js';
import { Collector, CollectorDB, currentTabLoader, listPage, postId } from './collector.js';
import { ServerSync } from './sync.js';
const collector = new Collector(new CollectorDB());
const pages = ['ui/sidebar.html', 'ui/manager.html'].map(p => browser.runtime.getURL(p));
const notify = message => void browser.runtime.sendMessage(message).catch(() => {});
// 수집과 열린 탭 보관은 동시에 돌지 않는다. busy: null | 'collect' | 'capture'
let busy = null, busyTimer = null;
function lock(kind) {
  if (busy === 'collect') throw new Error('supjav 수집 중입니다. 끝난 뒤 다시 시도하세요.');
  if (busy === 'capture') throw new Error('탭 정리 중입니다. 끝난 뒤 다시 시도하세요.');
  busy = kind; notify({ type: 'vault-busy', busy });
  clearTimeout(busyTimer); if (kind === 'capture') busyTimer = setTimeout(() => unlock('capture'), 120000); // 확인창을 닫지 않고 둔 경우 대비
}
function unlock(kind) { if (busy !== kind) return; busy = null; clearTimeout(busyTimer); notify({ type: 'vault-busy', busy }); }
// 서버 반영 기록(알림 없이 기록만): 확장 저장소에 최근 300개
const LOG_KEY = 'sync-log';
function syncLog(entry) {
  const line = { at: Date.now(), ...entry };
  console.info('[보관함 동기화]', line);
  try { const all = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); all.push(line); localStorage.setItem(LOG_KEY, JSON.stringify(all.slice(-300))); } catch { /* 기록 실패는 무시 */ }
}
// 지금 보고 있는 supjav 일본어 목록 탭에서 바로 수집을 시작한다. 결과는 진행/완료 알림으로 보낸다.
async function startHere({ windowId, mode, untilDate, maxPages }) {
  if (collector.running) throw new Error('이미 수집 중입니다.');
  lock('collect');
  try {
  const [tab] = await browser.tabs.query(Number.isInteger(windowId) ? { active: true, windowId } : { active: true, lastFocusedWindow: true });
  const startPage = tab && !tab.incognito ? listPage(tab.url) : null;
  if (!startPage) throw new Error('supjav 일본어 목록(https://supjav.com/ja/category/uncensored-jav)을 연 탭에서 수집을 누르세요.');
  const loader = currentTabLoader(browser, tab.id, { onChallenge: () => notify({ type: 'supjav-challenge' }) });
  const { items } = await service.db.snapshot();
  const known = new Set(items.flatMap(i => { const id = i.supjav?.id || postId(i.url); return id ? [String(id)] : []; }));
  collector.collect({ loader, startPage, mode, untilDate, maxPages, known, onProgress: p => notify({ type: 'supjav-progress', ...p }) })
    .then(async ({ posts, ...result }) => {
      try { result.vault = await service.ready.then(() => service.run(() => service.addCollected({ posts }))); }
      catch (error) { result.vaultError = error instanceof Error ? error.message : String(error); }
      await collector.db.put([], { id: 'last-run', ...result }).catch(() => {});
      sync.flush();
      notify({ type: 'supjav-done', result }); notify({ type: 'local-tab-vault-live' });
    }, error => notify({ type: 'supjav-done', error: error instanceof Error ? error.message : String(error) }))
    .finally(() => unlock('collect'));
  return { started: true, startPage, mode };
  } catch (error) { unlock('collect'); throw error; }
}
browser.runtime.onMessage.addListener((message,sender) => {
  if (sender.id !== browser.runtime.id || !pages.includes(sender.url)) return undefined;
  const reply = promise => promise.then(result => ({ ok: true, result }), error => ({ ok: false, error: error instanceof Error ? error.message : '작업을 완료하지 못했습니다.' }));
  if (message?.action === 'supjavList') return reply(collector.list());
  if (message?.action === 'supjavStart') return reply(startHere(message.args || {}));
  if (message?.action === 'supjavStop') return reply(Promise.resolve(collector.stop()));
  // 수집 목록 화면: 서버 보관함 기준(동기화 캐시)의 supjav 항목
  if (message?.action === 'busyState') return reply(Promise.resolve({ busy }));
  if (message?.action === 'syncLog') return reply(Promise.resolve(JSON.parse(localStorage.getItem(LOG_KEY) || '[]').slice(-50).reverse()));
  if (message?.action === 'captureStart') return reply((async () => {
    lock('capture');
    try { const r = await service.ready.then(() => service.run(() => service.capture(message.args || {}))); sync.flush(); refreshViews(); return r; }
    catch (error) { unlock('capture'); throw error; }
  })());
  if (message?.action === 'captureClose') return reply((async () => {
    try { const r = await service.run(() => service.closeJob(message.args || {})); refreshViews(); return r; }
    finally { unlock('capture'); }
  })());
  if (message?.action === 'tidyStart') return reply((async () => {
    lock('capture');
    try { return await service.ready.then(() => service.run(() => service.tidyPrepare(message.args || {}))); }
    catch (error) { unlock('capture'); throw error; }
  })());
  if (message?.action === 'tidyClose') return reply((async () => {
    try { const r = await service.run(() => service.tidyClose(message.args || {})); refreshViews(); return r; }
    finally { unlock('capture'); }
  })());
  if (message?.action === 'captureCancel') { unlock('capture'); return reply(Promise.resolve({ busy })); }
  if (message?.action === 'syncInfo') return reply(sync.info());
  if (message?.action === 'syncConfigure') return reply(sync.configure(message.args || {}));
  if (message?.action === 'syncDisable') return reply(sync.disable());
  if (message?.action === 'syncResync') return reply(sync.resync());
  return undefined;
});
const service = new VaultService(new VaultDB(), browser);
const sync = new ServerSync(service.db, { exclusive: fn => service.run(fn), onChange: () => refreshViews(), onStatus: info => void Promise.resolve(info).then(i => notify({ type: 'vault-sync-status', ...i })), log: syncLog });
void service.ready.then(() => sync.start()).catch(() => {});
const manager = browser.runtime.getURL('ui/manager.html');
const sidebar = browser.runtime.getURL('ui/sidebar.html');
browser.browserAction.onClicked.addListener(tab => {
  if (tab.incognito) return;
  // Call directly during the user gesture, before any awaited API.
  return browser.sidebarAction.open();
});
let refreshTimer;
function refreshViews() {
  clearTimeout(refreshTimer);
  refreshTimer=setTimeout(()=>{void browser.runtime.sendMessage({type:'local-tab-vault-live'}).catch(()=>{});},100);
}
browser.tabs.onCreated.addListener(tab => {
  void service.ready.then(()=>service.run(()=>service.onTabCreated(tab))).then(refreshViews).catch(refreshViews);
});
browser.tabs.onUpdated.addListener((id,change) => {
  service.changed(id);
  if(change.url===undefined && change.status!=='complete') return;
  void service.ready.then(()=>service.run(()=>service.onTabUpdated(id,change))).then(refreshViews).catch(refreshViews);
});
browser.tabs.onRemoved.addListener((id,info)=>{
  service.changed(id);
  void service.ready.then(()=>service.run(()=>service.onTabRemoved(id,info))).then(result=>{
    if(result.changed || result.closeFailed) void browser.runtime.sendMessage({type:'local-tab-vault-updated',...result}).catch(()=>{});
    refreshViews();
  }).catch(refreshViews);
});
browser.tabs.onAttached.addListener(id=>{
  service.changed(id);
  void service.ready.then(()=>service.run(()=>service.onTabUpdated(id,{status:'complete'}))).then(refreshViews).catch(refreshViews);
});
const actions = new Set(['prepareEmptyTrash','emptyTrash','preview','save','exportJSON','list','mutate','openOne','importJSON','openManager','autoSyncState','setAutoSync','themeState','setTheme','setWorkOrder']);
browser.runtime.onMessage.addListener((message,sender) => {
  if (sender.id !== browser.runtime.id || ![manager,sidebar].includes(sender.url) || !actions.has(message?.action)) return undefined;
  return service.run(async () => {
    try {
      const result=await service[message.action](message.args || {});
      if(message.action==='setAutoSync') await browser.runtime.sendMessage({type:'local-tab-vault-sync',enabled:result.enabled}).catch(()=>{});
      return { ok: true, result };
    }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : '작업을 완료하지 못했습니다.' }; }
  });
});

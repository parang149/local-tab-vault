import { check, source, sourceKey, sameTab, newItem, queryItems, validateBackup, restricted } from './model.js';

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
}
const SUPJAV_LIST = /^https:\/\/supjav\.com\/(?:[a-z]{2}\/)?category\//i;
export class VaultService {
  constructor(db, api) {
    this.db = db; this.api = api; this.session = crypto.randomUUID(); this.tail = Promise.resolve();
    this.previews = new Map(); this.tidyPlans = new Map(); this.epochs = new Map();
    this.suppressedRemovals = new Set(); this.watchedTabs = new Map(); this.syncEnabled = false; this.workflowBusy = false; this.workOrder = 'oldest'; this.ready = this.initializeSync();
  }
  async initializeSync() {
    try {
      const { settings } = await this.db.snapshot();
      // Work is deliberately not resumed after a restart: events may have been missed.
      this.syncEnabled = false;
      await this.db.commit({settings:[{id:'auto-sync',enabled:false,updatedAt:Date.now()},{id:'workflow',enabled:false,updatedAt:Date.now()}],workTabs:[...(await this.db.snapshot()).workTabs.map(t=>({...t,stale:true}))]});
    } catch { this.syncEnabled = false; }
  }
  async refreshWatchedTabs() {
    const tabs = await this.normalTabs();
    this.watchedTabs.clear();
    for (const tab of tabs) if (!tab.incognito && !this.isOwn(tab.url) && typeof tab.url === 'string') this.watchedTabs.set(tab.id,{url:tab.url,windowId:tab.windowId,incognito:false});
  }
  async setAutoSync({ enabled }) {
    check(typeof enabled === 'boolean', '동기화 설정이 올바르지 않습니다.');
    await this.ready;
    if (enabled) {
      const {items}=await this.db.snapshot();
      check(items.some(i=>i.deletedAt===null && i.status!=='done' && !restricted(i.url)), '작업할 미완료 항목이 없습니다.');
      await this.refreshWatchedTabs();
      await this.db.commit({workTabs:[]}); this.workflowBusy=true;
    } else { this.watchedTabs.clear(); this.workflowBusy=false; }
    await this.db.commit({settings:[{id:'auto-sync',enabled,updatedAt:Date.now()},{id:'workflow',enabled,updatedAt:Date.now()}]});
    this.syncEnabled=enabled;
    return {enabled:this.syncEnabled,tracked:this.watchedTabs.size};
  }
  async autoSyncState() { await this.ready; return {enabled:this.syncEnabled}; }
  async themeState() { const {settings}=await this.db.snapshot(); return {settings:settings.find(s=>s.id==='theme')?.theme || 'system'}; }
  async setTheme({theme}) { check(['system','light','dark'].includes(theme),'테마 설정이 올바르지 않습니다.'); await this.db.commit({settings:[{id:'theme',theme,updatedAt:Date.now()}]}); return {theme}; }
  async onTabCreated(tab) {
    if(this.syncEnabled) await this.onTabUpdated(tab.id,{status:'complete'});
  }
  async onTabUpdated(id, change) {
    this.changed(id);
    if (!this.syncEnabled || (change.url === undefined && change.status !== 'complete')) return;
    try { const tab=(await this.normalTabs()).find(t=>t.id===id); if(!tab || typeof tab.url!=='string') this.watchedTabs.delete(id); else this.watchedTabs.set(id,{url:tab.url,windowId:tab.windowId,incognito:false}); } catch { this.watchedTabs.delete(id); }
  }
  async onTabRemoved(id, info={}) {
    const previous=this.watchedTabs.get(id);this.watchedTabs.delete(id);this.changed(id);
    if(this.suppressedRemovals.delete(id)) return {changed:0};
    if(!this.syncEnabled || !this.workflowBusy || info.isWindowClosing || !previous || previous.incognito || this.isOwn(previous.url) || restricted(previous.url)) return {changed:0};
    const {items:archive}=await this.db.snapshot();
    if(!archive.some(i=>i.deletedAt===null && i.status!=='done' && i.url===previous.url)) return {changed:0};
    const live=await this.normalTabs();
    try {
      for(const duplicate of live.filter(t=>t.url===previous.url)) {
        const tab=await this.api.tabs.get(duplicate.id);
        if(tab.incognito || tab.url!==previous.url || tab.pendingUrl || tab.windowId!==duplicate.windowId) return {changed:0,closeFailed:true};
        this.suppressedRemovals.add(tab.id);
        try { await this.api.tabs.remove(tab.id); }
        catch(e) { this.suppressedRemovals.delete(tab.id); throw e; }
      }
      if((await this.normalTabs()).some(t=>t.url===previous.url)) return {changed:0,closeFailed:true};
    } catch { return {changed:0,closeFailed:true}; }
    const stateBefore=await this.db.snapshot();
    const {items}=await this.db.snapshot(); const now=Date.now(); const changed=[];
    // Complete duplicate archive entries once, only after every matching tab closes.
    const completedIds=new Set();
    for(const item of items) if(item.deletedAt===null && item.url===previous.url && ['unread','reviewing'].includes(item.status)) {item.status='done';item.updatedAt=now;item.lastViewedAt=now;item.completedAt=now;changed.push(item);completedIds.add(item.id);}
    if(changed.length) await this.db.commit({items:changed,workTabs:stateBefore.workTabs.filter(t=>t.closedAt)});
    let opened=null, nextFailed=false;
    if(changed.length && this.workflowBusy) {
      const ordered=[...items].sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id));
      // 최신순으로 볼 때는 화면 아래쪽(더 오래 저장된 항목)으로 진행한다.
      if(this.workOrder==='newest') ordered.reverse();
      const completedPositions=ordered.map((i,n)=>completedIds.has(i.id)?n:-1).filter(n=>n>=0);
      const firstIndex=Math.min(...completedPositions), lastIndex=Math.max(...completedPositions);
      const candidates=ordered.filter(i=>i.deletedAt===null && i.status!=='done' && !restricted(i.url));
      let next=candidates.find(i=>ordered.indexOf(i)>lastIndex);
      if(!next) next=[...candidates].reverse().find(i=>ordered.indexOf(i)<firstIndex);
      if(next) { this.workflowBusy=false; try { await this.openOne({id:next.id,active:true,windowId:previous.windowId,workflow:true}); opened=next.id; } catch { nextFailed=true; } finally { this.workflowBusy=this.syncEnabled; } }
    }
    return {changed:changed.length,opened,nextFailed};
  }
  changed(id) { this.epochs.set(id, (this.epochs.get(id) || 0) + 1); }
  run(fn) { const p = this.tail.then(fn); this.tail = p.catch(() => {}); return p; }
  isOwn(url) { return typeof url === 'string' && url.startsWith(this.api.runtime.getURL('')); }
  async collect(scope, windowId) {
    check(scope === 'current' || scope === 'all', '저장 범위를 선택하세요.');
    const windows = await this.api.windows.getAll({ windowTypes: ['normal'] });
    const allowed = new Set(windows.filter(w => w.type === 'normal' && !w.incognito && (scope === 'all' || w.id === windowId)).map(w => w.id));
    check(scope !== 'current' || allowed.has(windowId), '일반 창에서 관리 화면을 여세요.');
    const tabs = await this.api.tabs.query({});
    // 일반 웹(http/https)만. about:·확장·file: 등 브라우저 내부 탭과 supjav 목록 페이지(수집 시작 화면)는 저장하지 않는다.
    const chosen = tabs.filter(t => allowed.has(t.windowId) && !t.incognito && !this.isOwn(t.url) && !restricted(t.url || '') && !SUPJAV_LIST.test(t.url || ''));
    const ready = chosen.filter(t => !t.pendingUrl && t.status !== 'loading');
    this.skippedLoading = chosen.length - ready.length; // 로딩 중인 탭은 빼고 진행
    return ready.map(t => ({ ...source(t), epoch: this.epochs.get(t.id) || 0 })).sort((a,b) => a.windowId - b.windowId || a.index - b.index);
  }
  // 열린 탭 보관: 로컬 저장 → 로컬 검증까지. 닫기는 closeJob(확인창 뒤)에서 한다.
  async capture({ scope, windowId, dedupe = true }) {
    const sources = await this.collect(scope, windowId);
    const loading = this.skippedLoading || 0;
    check(sources.length > 0, loading ? `저장 대상 탭이 없습니다(로딩 중 ${loading}개 제외).` : '저장 대상 탭이 없습니다.');
    const saved = await this.saveSources(sources, scope, dedupe);
    return { ...saved, created: saved.reused ? 0 : saved.created, loading };
  }
  async preview({ scope, windowId, dedupe }) {
    const sources = await this.collect(scope, windowId);
    const state = await this.db.snapshot();
    const active = state.items.filter(i => i.deletedAt === null);
    const seen = new Set(active.map(i => i.url));
    const unique = new Set(); let duplicate = 0;
    for (const s of sources) { if (seen.has(s.url) || unique.has(s.url)) duplicate++; unique.add(s.url); }
    const id = crypto.randomUUID();
    this.previews.clear();
    this.previews.set(id, { id, scope, windowId, dedupe: !!dedupe, sources, at: Date.now() });
    return { id, count: sources.length, duplicate, unique: unique.size, restricted: sources.filter(s => restricted(s.url)).length, dedupe: !!dedupe };
  }
  async save({ previewId }) {
    const p = this.previews.get(previewId);
    check(p && Date.now() - p.at < 15*60*1000, '미리보기가 만료되었습니다. 다시 확인하세요.');
    const fresh = await this.collect(p.scope, p.windowId);
    check(JSON.stringify(fresh) === JSON.stringify(p.sources), '미리보기 이후 탭이 변경되었습니다. 다시 미리보기 하세요.');
    check(fresh.length > 0, '저장 대상 탭이 없습니다.');
    return this.saveSources(fresh, p.scope, p.dedupe);
  }
  async saveSources(fresh, scope, dedupeOption) {
    const p = { scope, dedupe: !!dedupeOption };
    const state = await this.db.snapshot();
    const fingerprint = await digest({ session: this.session, dedupe: p.dedupe, sources: fresh });
    const existingJob = state.jobs.find(j => j.fingerprint === fingerprint);
    if (existingJob) { await this.verify(existingJob); return this.summary(existingJob, true); }
    const byId = new Map(state.items.map(i => [i.id,i]));
    const byUrl = new Map(state.items.filter(i => i.deletedAt === null).map(i => [i.url,i]));
    const checkpoints = new Map(state.checkpoints.map(c => [c.id,c]));
    const changed = new Map(); const cps = []; const refs = []; const now = Date.now();
    let created = 0;
    for (const s of fresh) {
      const key = sourceKey(this.session, s);
      const cp = checkpoints.get(key);
      let item = cp && byId.get(cp.itemId);
      if (item?.deletedAt !== null) item = null;
      if (!item && p.dedupe) item = byUrl.get(s.url);
      if (!item) { item = newItem(s, now + created / 10000); created++; byId.set(item.id,item); byUrl.set(s.url,item); }
      else if (!item.sources.some(old => JSON.stringify(old) === JSON.stringify(s))) item.sources.push(s);
      changed.set(item.id,item);
      cps.push({ id: key, itemId: item.id }); refs.push({ itemId: item.id, source: s });
    }
    const job = { id: crypto.randomUUID(), fingerprint, session: this.session, createdAt: now, scope: p.scope, dedupe: p.dedupe, captured: fresh.length, created, refs };
    await this.db.commit({ items: [...changed.values()], jobs: [job], checkpoints: cps });
    await this.verify(job);
    return this.summary(job, false);
  }
  summary(job, reused) { return { id: job.id, captured: job.captured, created: job.created, represented: new Set(job.refs.map(r => r.itemId)).size, restricted: job.refs.filter(r => restricted(r.source.url)).length, reused, verified: true }; }
  async verify(job) {
    const state = await this.db.snapshot();
    const stored = state.jobs.find(j => j.id === job.id);
    check(stored && JSON.stringify(stored) === JSON.stringify(job) && stored.refs.length === stored.captured, '저장 작업 검증에 실패했습니다. 탭 닫기가 차단되었습니다.');
    const items = new Map(state.items.map(i => [i.id,i]));
    check(new Set(stored.refs.map(r => r.source.tabId)).size === stored.captured, '수집 탭 개수가 일치하지 않습니다.');
    for (const r of stored.refs) {
      const item = items.get(r.itemId);
      check(item && item.deletedAt === null && item.url === r.source.url && item.sources.some(s => JSON.stringify(s) === JSON.stringify(r.source)), '일부 저장 항목이 없거나 휴지통에 있습니다. 탭 닫기가 차단되었습니다.');
    }
    return stored;
  }
  async exportJSON() {
    const state = await this.db.snapshot();
    const data = { format: 'local-tab-vault', version: 3, exportedAt: Date.now(), ...state, settings: state.settings.filter(s => s.id !== 'server-sync') };
    return data;
  }
  async openManager({ windowId, active = true }) {
    const windows = await this.api.windows.getAll({ windowTypes: ['normal'] });
    check(windows.some(w => w.id === windowId && w.type === 'normal' && !w.incognito), '일반 창에서 열어주세요.');
    const url = this.api.runtime.getURL('ui/manager.html');
    const own = (await this.api.tabs.query({})).find(t => t.windowId === windowId && !t.incognito && t.url === url);
    if (own) { if (active) await this.api.tabs.update(own.id, { active: true }); }
    else await this.api.tabs.create({ url, windowId, active });
    return { opened: true };
  }
  // 검증된 저장 작업의 탭을 닫는다. 저장 뒤 바뀐 탭은 열어 두고, 창의 탭이 모두 닫히게 되면 빈 새 탭을 먼저 연다.
  async closeJob({ jobId }) {
    const { jobs } = await this.db.snapshot();
    const job = jobs.find(j => j.id === jobId);
    check(job && job.session === this.session, '이 실행에서 저장한 작업만 닫을 수 있습니다.');
    await this.verify(job);
    const r = await this.closeSources(job.refs.map(r => r.source));
    return { closed: r.closed, kept: job.captured - r.closed };
  }
  // 정리: 열린 탭 중 주소가 이미 보관함(미완료·완료, 휴지통 제외)에 있는 탭만 고른다. 새로 저장하지 않는다.
  async tidyPrepare({ scope, windowId }) {
    const sources = await this.collect(scope, windowId);
    const live = new Set((await this.db.snapshot()).items.filter(i => i.deletedAt === null).map(i => i.url));
    const matched = sources.filter(s => live.has(s.url));
    const id = crypto.randomUUID();
    this.tidyPlans.clear(); this.tidyPlans.set(id, { sources: matched, at: Date.now() });
    return { id, count: matched.length, loading: this.skippedLoading || 0 };
  }
  async tidyClose({ id }) {
    const plan = this.tidyPlans.get(id); this.tidyPlans.delete(id);
    check(plan && Date.now() - plan.at < 10 * 60 * 1000, '정리 계획이 만료되었습니다. 다시 누르세요.');
    // 로컬 검증: DB를 다시 읽어 주소가 아직 살아 있는 항목만 닫는다.
    const live = new Set((await this.db.snapshot()).items.filter(i => i.deletedAt === null).map(i => i.url));
    const verified = plan.sources.filter(s => live.has(s.url));
    const r = await this.closeSources(verified);
    return { closed: r.closed, kept: plan.sources.length - r.closed };
  }
  // 저장 때와 같은 탭만 닫는다. 창의 탭이 모두 닫히게 되면 빈 새 탭을 먼저 열고, 작업 시작 반응은 막는다.
  async closeSources(sources) {
    const tabs = await this.api.tabs.query({});
    const windows = await this.api.windows.getAll({ windowTypes: ['normal'] });
    const normal = new Set(windows.filter(w => w.type === 'normal' && !w.incognito).map(w => w.id));
    const byId = new Map(tabs.map(t => [t.id, t]));
    const targets = sources.filter(s => !restricted(s.url) && normal.has(s.windowId) && !this.isOwn(s.url)
      && sameTab(s, byId.get(s.tabId)) && s.epoch === (this.epochs.get(s.tabId) || 0));
    const closing = new Set(targets.map(s => s.tabId));
    for (const w of new Set(targets.map(s => s.windowId))) {
      if (!tabs.some(t => t.windowId === w && !closing.has(t.id))) await this.api.tabs.create({ windowId: w, active: true });
    }
    let closed = 0;
    for (const s of targets) {
      try {
        const t = await this.api.tabs.get(s.tabId);
        if (!sameTab(s, t) || s.epoch !== (this.epochs.get(s.tabId) || 0)) continue;
        this.suppressedRemovals.add(s.tabId);
        try { await this.api.tabs.remove(s.tabId); closed++; } catch { this.suppressedRemovals.delete(s.tabId); }
      } catch { /* 이미 닫힌 탭 */ }
    }
    return { closed };
  }
  async normalTabs() {
    const windows=await this.api.windows.getAll({windowTypes:['normal']});
    const allowed=new Set(windows.filter(w=>w.type==='normal' && !w.incognito).map(w=>w.id));
    return (await this.api.tabs.query({})).filter(t=>allowed.has(t.windowId) && !t.incognito && !this.isOwn(t.url));
  }
  async list(options) {
    const urls=new Set((await this.normalTabs()).map(t=>t.url));
    const {items}=await this.db.snapshot();
    return queryItems(items.map(i=>i.deletedAt===null && i.status!=='done'
      ? {...i,status:urls.has(i.url)?'reviewing':'unread'} : i),options);
  }
  async setWorkOrder({ order }) {
    check(order === 'oldest' || order === 'newest', '작업 순서가 올바르지 않습니다.');
    this.workOrder = order;
    return { order };
  }
  // supjav 수집 글을 보관함 항목으로 넣는다. 같은 URL이 이미 있으면(완료·휴지통 포함) 건너뛴다.
  // 게시 날짜가 오래된 글부터 저장해 저장 순서가 시간순을 유지하게 한다.
  async addCollected({ posts }) {
    check(Array.isArray(posts) && posts.length <= 10000, '수집 결과가 올바르지 않습니다.');
    const { items } = await this.db.snapshot();
    const urls = new Set(items.map(i => i.url));
    const ordered = posts.filter(p => p && typeof p.url === 'string' && /^https:\/\/supjav\.com\//.test(p.url) && typeof p.title === 'string')
      .reverse(); // 화면 읽은 순서(좌상단→우하단→다음 쪽)를 거꾸로 넣어 최신순 = supjav 화면 순서
    const base = Math.max(Date.now(), ...items.map(i => i.createdAt + 1)), created = [];
    for (const p of ordered) {
      if (urls.has(p.url)) continue;
      urls.add(p.url);
      const at = base + created.length;
      created.push({ id: crypto.randomUUID(), url: p.url, title: p.title.slice(0, 1000), status: 'unread', note: '', tags: ['supjav'], createdAt: at, updatedAt: at, lastViewedAt: null, completedAt: null, deletedAt: null, warning: false, sources: [], supjav: { id: p.id, thumb: p.thumb || null, date: p.date || null } });
    }
    if (created.length) await this.db.commit({ items: created }, {}, { op: 'merge' });
    // 로컬 검증: 다시 읽어서 이번 수집 주소마다 항목이 있는지 대조(휴지통 항목도 있음으로 침)
    const stored = new Set((await this.db.snapshot()).items.map(i => i.url));
    const missing = ordered.filter(p => !stored.has(p.url)).length;
    check(!missing, `로컬 저장 검증 실패: ${missing}개가 보관함에 없습니다.`);
    return { added: created.length, skipped: ordered.length - created.length, verified: ordered.length };
  }
  async prepareEmptyTrash() {
    const {items}=await this.db.snapshot();
    return {ids:items.filter(i=>i.deletedAt!==null).map(i=>i.id)};
  }
  async emptyTrash({ids,confirmed}) {
    check(Array.isArray(ids) && ids.length>0 && new Set(ids).size===ids.length,'휴지통이 비어 있거나 요청이 올바르지 않습니다.');
    check(confirmed===true,'영구 삭제 확인이 필요합니다.');
    const state=await this.db.snapshot();
    const targets=new Set(ids), trash=state.items.filter(i=>i.deletedAt!==null);
    check(trash.length===ids.length && trash.every(i=>targets.has(i.id)),'휴지통 내용이 변경되었습니다. 다시 확인하세요.');
    this.previews.clear();
    await this.db.commit({},{
      items:ids,
      jobs:state.jobs.filter(j=>j.refs.some(r=>targets.has(r.itemId))).map(j=>j.id),
      checkpoints:state.checkpoints.filter(c=>targets.has(c.itemId)).map(c=>c.id),
      workTabs:state.workTabs.filter(t=>targets.has(t.itemId)).map(t=>t.id)
    });
    return {removed:ids.length};
  }
  async mutate({ ids, action, note, tags, status }) {
    check(Array.isArray(ids) && ids.length > 0 && ids.length <= 100000, '항목을 선택하세요.');
    const { items } = await this.db.snapshot(); const byId = new Map(items.map(i => [i.id,i]));
    const selected = [...new Set(ids)].map(id => byId.get(id)); check(selected.every(Boolean), '항목을 찾을 수 없습니다.');
    const now = Date.now();
    for (const i of selected) {
      if (action === 'delete') i.deletedAt = now;
      else if (action === 'restore') i.deletedAt = null;
      else if (action === 'status') { check(['unread','reviewing','done'].includes(status) && i.deletedAt === null, '상태를 변경할 수 없습니다.'); i.status = status; i.completedAt=status==='done'?(i.completedAt||now):null; }
      else if (action === 'edit') { check(ids.length === 1 && typeof note === 'string' && note.length <= 100000 && Array.isArray(tags) && tags.length <= 100 && tags.every(t => typeof t === 'string' && t.length <= 200), '메모·태그 길이를 확인하세요.'); i.note = note; i.tags = [...new Set(tags)]; }
      else throw new Error('지원하지 않는 작업입니다.');
      i.updatedAt = now;
    }
    await this.db.commit({ items: selected }); return { changed: selected.length };
  }
  async openOne({ id, active, windowId, workflow=false }) {
    const { items } = await this.db.snapshot(); const i = items.find(i => i.id === id && i.deletedAt === null);
    check(i && !restricted(i.url), '복원이 제한되는 URL입니다. 주소를 복사해 직접 확인하세요.');
    const s = i.sources[0];
    const props = { url: 'about:blank', active: false, windowId, pinned: !!s?.pinned };
    if (s?.cookieStoreId && s.cookieStoreId !== 'firefox-default') {
      check(await this.api.permissions.contains({ permissions: ['cookies'] }), '원래 컨테이너로 열려면 컨테이너 권한을 허용하세요.');
      props.cookieStoreId = s.cookieStoreId;
    }
    let tab;
    try { tab = await this.api.tabs.create(props); await this.api.tabs.update(tab.id, { muted: !!s?.muted, url: i.url, active: !!active }); }
    catch { if(tab?.id!==undefined)try{await this.api.tabs.remove(tab.id);}catch{} throw new Error('탭을 열지 못했습니다. 컨테이너 존재 여부를 확인하세요.'); }
    i.lastViewedAt = Date.now(); i.updatedAt = i.lastViewedAt;
    if (i.status === 'unread') i.status = 'reviewing';
    if(workflow) { const {workTabs}=await this.db.snapshot(); await this.db.commit({items:[i],workTabs:[...workTabs.filter(t=>!t.closedAt),{id:tab.id,itemId:i.id,url:i.url,windowId,openedAt:Date.now(),stale:false}]}); if(this.syncEnabled)this.watchedTabs.set(tab.id,{url:i.url,windowId,incognito:false}); return {opened:1}; }
    await this.db.commit({ items: [i] }); return { opened: 1 };
  }
  async importJSON({ data }) {
    validateBackup(data);
    const state = await this.db.snapshot(); const existing = new Map(state.items.map(i => [i.id,i]));
    const added = []; let skipped = 0;
    for (const raw of data.items) {
      if (existing.has(raw.id)) { skipped++; continue; }
      // Explicit field allowlist. Imported jobs can never authorize closing live tabs.
      const { id,url,title,status,note,tags,createdAt,updatedAt,lastViewedAt,completedAt,deletedAt,sources } = raw;
      added.push({ id,url,title,status,note,tags,createdAt,updatedAt,lastViewedAt,completedAt:completedAt ?? null,deletedAt,sources,warning: restricted(url) });
    }
    await this.db.commit({ items: added });
    const after = await this.db.snapshot(); const byId = new Map(after.items.map(i => [i.id,i]));
    check(added.every(i => JSON.stringify(byId.get(i.id)) === JSON.stringify(i)), '가져오기 검증에 실패했습니다. 원본 JSON 파일을 보관하세요.');
    return { added: added.length, skipped };
  }
}

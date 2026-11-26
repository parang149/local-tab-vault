// supjav 일본어 목록 페이지에서 게시물 URL·제목·썸네일 URL·게시 날짜만 수집한다.
// 사용자가 연 목록 탭에서 그대로 쪽을 넘기며 읽는다. 게시물 페이지에는 들어가지 않는다.
export const LIST_URL = 'https://supjav.com/ja/category/uncensored-jav';
export const MAX_PAGES = 100;
export const MAX_DATE_PAGES = 200;

export function pageUrl(page) { return page <= 1 ? LIST_URL : `${LIST_URL}/page/${page}`; }

function clean(url) {
  try { const u = new URL(url); u.search = ''; u.hash = ''; return u.href; } catch { return null; }
}

// 일본어 목록 주소면 쪽 번호, 아니면 null
export function listPage(url) {
  const m = /^https:\/\/supjav\.com\/ja\/category\/uncensored-jav(?:\/page\/(\d{1,5}))?\/?$/.exec(clean(url) || '');
  return m ? Math.max(1, Number(m[1] || 1)) : null;
}

export function postId(url) {
  const m = /^https:\/\/supjav\.com\/(?:ja\/)?(\d{1,12})\.html$/.exec(clean(url) || '');
  return m ? m[1] : null;
}

export function thumbUrl(url) {
  const u = clean(url);
  return u && /^https:\/\/img\.supjav\.com\/[^\s]+$/.test(u) ? u : null;
}

export function postDate(meta) {
  if (!meta) return null;
  const copy = meta.cloneNode(true);
  copy.querySelectorAll('span').forEach(s => s.remove());
  const m = /(\d{4})\/(\d{2})\/(\d{2})/.exec(copy.textContent || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const CHALLENGE_TITLE = /just a moment|잠시만 기다리십시오|しばらくお待ちください|attention required/i;
export function isChallenge(status, doc) {
  if (status === 403 || status === 503 || status === 429) return true;
  return CHALLENGE_TITLE.test(doc?.title || '') || !!doc?.querySelector('#challenge-form, #challenge-error-text, script[src*="challenge-platform"]');
}

export function parseList(doc) {
  const posts = [];
  const seen = new Set();
  for (const post of doc.querySelectorAll('.post')) {
    const link = post.querySelector('a.img[href]') || post.querySelector('a[href]');
    const url = clean(link?.getAttribute('href') ? new URL(link.getAttribute('href'), LIST_URL).href : '');
    const id = postId(url);
    if (!id || seen.has(id)) continue;
    const img = post.querySelector('img');
    const title = (link.getAttribute('title') || post.querySelector('h3')?.textContent || img?.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
    if (!title) continue;
    seen.add(id);
    posts.push({ id, url, title: title.slice(0, 1000), thumb: thumbUrl(img?.getAttribute('data-original') || img?.getAttribute('src') || ''), date: postDate(post.querySelector('.meta')) });
  }
  return posts;
}

export class CollectorDB {
  constructor(name = 'supjav-collector-v1') { this.name = name; }
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('posts', { keyPath: 'id' }); r.result.createObjectStore('meta', { keyPath: 'id' }); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error('수집 저장소를 열지 못했습니다.'));
    });
    return this.db;
  }
  async all(store = 'posts') {
    const db = await this.open();
    return new Promise((resolve, reject) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
  }
  async put(posts, meta) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['posts', 'meta'], 'readwrite');
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(new Error('수집 결과를 저장하지 못했습니다.'));
      for (const p of posts) tx.objectStore('posts').put(p);
      if (meta) tx.objectStore('meta').put(meta);
    });
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const named = (name, message) => Object.assign(new Error(message), { name });

// 사용자가 연 탭 하나에서 쪽을 넘기며 읽는다. 새 탭은 열지 않고, 끝나도 마지막 쪽에 그대로 둔다.
export function currentTabLoader(api, tabId, { loadTimeout = 30000, solveTimeout = 180000, poll = 1000, onChallenge = () => {} } = {}) {
  let expected = null;
  function complete(ms) {
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { clearTimeout(timer); api.tabs.onUpdated.removeListener(updated); api.tabs.onRemoved.removeListener(removed); fn(v); };
      const updated = (id, change) => { if (id === tabId && change.status === 'complete') done(resolve); };
      const removed = id => { if (id === tabId) done(reject, named('TabClosed', '수집하던 탭이 닫혔습니다.')); };
      const timer = setTimeout(() => done(reject, named('TimeoutError', '페이지가 열리지 않습니다.')), ms);
      api.tabs.onUpdated.addListener(updated); api.tabs.onRemoved.addListener(removed);
    });
  }
  async function current() {
    try { return await api.tabs.get(tabId); } catch { throw named('TabClosed', '수집하던 탭이 닫혔습니다.'); }
  }
  async function read() {
    const [page] = await api.tabs.executeScript(tabId, { code: '({ title: document.title, html: document.documentElement.outerHTML })' });
    return page || { title: '', html: '' };
  }
  return {
    async load(url, { onStage = () => {} } = {}) {
      const tab = await current();
      if (expected && clean(tab.url) !== expected) throw named('TabMoved', '수집 중에 탭이 다른 페이지로 이동했습니다.');
      if (clean(tab.url) !== url) { const loaded = complete(loadTimeout); await api.tabs.update(tabId, { url }); await loaded; }
      else if (tab.status !== 'complete') await complete(loadTimeout);
      onStage('response', null);
      let page = await read();
      if (CHALLENGE_TITLE.test(page.title)) {
        onChallenge();
        const until = Date.now() + solveTimeout;
        while (CHALLENGE_TITLE.test(page.title) && Date.now() < until) {
          await wait(poll);
          await current();
          try { page = await read(); } catch { /* 확인 후 페이지가 바뀌는 중 */ }
        }
        if (!CHALLENGE_TITLE.test(page.title)) { await wait(500); page = await read(); }
      }
      expected = url;
      return { status: null, ok: true, html: page.html };
    }
  };
}

export class Collector {
  constructor(db, { parse = html => new DOMParser().parseFromString(html, 'text/html'), delay = () => wait(1000 + Math.random() * 500), now = () => Date.now() } = {}) {
    this.db = db; this.parse = parse; this.delay = delay; this.now = now; this.running = false; this.stopRequested = false;
  }
  async list() {
    const posts = await this.db.all();
    posts.sort((a, b) => (b.date || '').localeCompare(a.date || '') || Number(b.id) - Number(a.id));
    const last = (await this.db.all('meta')).find(m => m.id === 'last-run') || null;
    return { posts, last, running: this.running };
  }
  stop() { if (this.running) this.stopRequested = true; return { stopping: this.running }; }
  // mode 'new': 새 게시물이 하나도 없는 쪽에서 멈춤(최대 maxPages쪽).
  // mode 'date': untilDate(YYYY-MM-DD)보다 오래된 글이 나온 쪽에서 멈추고, 그 날짜 이후 글만 저장.
  // known: 서버 기준 보관함에 이미 있는 글 ID. 주면 새 글 판단을 이 목록으로 한다(다른 PC가 수집한 글 포함).
  async collect({ loader, startPage = 1, mode = 'new', untilDate = null, maxPages = 5, onProgress = () => {}, known = null } = {}) {
    if (this.running) throw new Error('이미 수집 중입니다.');
    const dateMode = mode === 'date';
    if (dateMode && !/^\d{4}-\d{2}-\d{2}$/.test(untilDate || '')) throw new Error('수집할 날짜를 정해 주세요.');
    this.running = true; this.stopRequested = false;
    try {
      const limit = dateMode ? MAX_DATE_PAGES : Math.max(1, Math.min(MAX_PAGES, Number(maxPages) || 1));
      const existing = new Map((await this.db.all()).map(p => [p.id, p]));
      let added = 0, updated = 0, read = 0, reason = 'limit', detail = null, lastPage = null;
      const seenInRun = new Map();
      for (let i = 0; i < limit; i++) {
        const page = startPage + i;
        if (i > 0) {
          if (this.stopRequested) { reason = 'stopped'; break; }
          await this.delay();
          if (this.stopRequested) { reason = 'stopped'; break; }
        }
        onProgress({ page, step: i + 1, limit, added, stage: 'request' });
        let res;
        try { res = await loader.load(pageUrl(page), { onStage: (stage, status) => onProgress({ page, step: i + 1, limit, added, stage, status }) }); }
        catch (error) {
          reason = { TimeoutError: 'timeout', TabClosed: 'tab-closed', TabMoved: 'tab-moved' }[error?.name] || 'network';
          detail = { page, error: error?.name || 'Error', message: String(error?.message || '').slice(0, 200) };
          break;
        }
        const doc = this.parse(res.html);
        detail = { page, status: res.status, title: String(doc.title || '').slice(0, 80), bytes: res.html.length };
        if (isChallenge(res.status, doc)) { reason = 'challenge'; break; }
        if (!res.ok) { reason = res.status === 404 ? 'end' : 'http'; break; }
        let posts = parseList(doc);
        read++; lastPage = page;
        if (!posts.length) { reason = i === 0 ? 'structure' : 'end'; break; }
        let older = false;
        if (dateMode) { const keep = posts.filter(p => !p.date || p.date >= untilDate); older = keep.length < posts.length; posts = keep; }
        const now = this.now(), changes = [];
        let fresh = 0;
        for (const p of posts) {
          const old = existing.get(p.id);
          const isNew = known ? !known.has(p.id) : !old;
          if (known) known.add(p.id);
          if (isNew) fresh++;
          if (!old) { const item = { ...p, firstSeenAt: now, lastSeenAt: now }; existing.set(p.id, item); changes.push(item); continue; }
          const next = { ...old, url: p.url, title: p.title, thumb: p.thumb || old.thumb, date: p.date || old.date, lastSeenAt: now };
          if (next.title !== old.title || next.thumb !== old.thumb || next.date !== old.date) updated++;
          existing.set(p.id, next); changes.push(next);
        }
        added += fresh;
        for (const item of changes) seenInRun.set(item.id, item);
        if (changes.length) await this.db.put(changes);
        if (dateMode && older) { reason = 'date-reached'; break; }
        if (!dateMode && !fresh) { reason = 'caught-up'; break; }
      }
      const result = { added, updated, pages: read, lastPage, reason, detail, mode, untilDate: dateMode ? untilDate : null, total: existing.size, at: this.now() };
      await this.db.put([], { id: 'last-run', ...result });
      return { ...result, posts: [...seenInRun.values()] };
    } finally { this.running = false; this.stopRequested = false; }
  }
}

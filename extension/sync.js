// hitomi-web 서버 보관함과 실시간 동기화. 서버가 기준이고 이 PC의 IndexedDB는 캐시 + 미반영 대기열이다.
const ADDRESS = /^(https?:\/\/[^/?#]+)\/api\/vault\/([0-9a-f]{64})\/?$/i;
export function parseAddress(url) {
  const m = ADDRESS.exec(String(url || '').trim());
  return m ? { origin: m[1], url: `${m[1]}/api/vault/${m[2].toLowerCase()}` } : null;
}
// 탭 제목 등에 깨진 이모지(짝 없는 서러게이트)가 있으면 서버 JSON 해석이 실패하므로 U+FFFD로 바꿔 보낸다.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const wellFormed = (_, v) => typeof v === 'string' ? (v.toWellFormed ? v.toWellFormed() : v.replace(LONE, '�')) : v;

export class ServerSync {
  constructor(db, { fetch = (...a) => globalThis.fetch(...a), EventSource = globalThis.EventSource, onChange = () => {}, onStatus = () => {}, delay = 1000, maxBackoff = 60000, exclusive = fn => fn(), log = () => {} } = {}) {
    // exclusive: 보관함 작업 큐. 화면 작업(읽고-고쳐-저장) 사이에 서버 변경이 끼어들지 않게 한다.
    Object.assign(this, { db, fetchImpl: fetch, ES: EventSource, onChange, onStatus, delay, maxBackoff, exclusive, log });
    this.state = null; this.status = 'off'; this.error = ''; this.tail = Promise.resolve(); this.backoff = 1000;
    this.source = null; this.pushTimer = null; this.retryTimer = null; this.lastSync = null;
    db.onQueued = () => this.schedulePush();
  }
  serial(fn) { const run = this.tail.then(fn, fn); this.tail = run.catch(() => {}); return run; }
  setStatus(status, error = '') { this.status = status; this.error = error; this.onStatus(this.info()); }
  async info() { return { status: this.status, error: this.error, enabled: !!this.state?.enabled, address: this.state?.url ? this.state.url.replace(/[0-9a-f]{64}$/i, m => `${m.slice(0, 6)}…`) : '', name: this.state?.name || '', pending: await this.db.countPending().catch(() => 0), lastSync: this.lastSync }; }
  async saveState(patch) { this.state = { ...this.state, ...patch }; await this.db.commit({ settings: [this.state] }, {}, { remote: true }); }
  async start() {
    const { settings } = await this.db.snapshot();
    this.state = settings.find(s => s.id === 'server-sync') || null;
    // 서버 주소를 한 번이라도 넣었으면 로컬 모드(연동 꺼짐)에서도 변경을 대기열에 기록한다 → 다시 켜면 먼저 올라감.
    this.db.sync = !!this.state?.url;
    if (this.state?.enabled) this.connect();
    else this.setStatus('off');
  }
  // 새 주소로 연결. 이 PC의 기존 항목은 서버에 merge(같은 URL이면 서버 것 유지)로 올린 뒤 서버 기준으로 캐시를 다시 받는다.
  async configure({ url, name }) {
    const address = parseAddress(url);
    if (!address) throw new Error('hitomi-web 설정 › API의 "확장에 넣을 주소"를 그대로 붙여 넣으세요.');
    const sameServer = this.state?.url === address.url;
    await this.serial(async () => {
      this.close();
      await this.saveState({ id: 'server-sync', enabled: true, url: address.url, name: String(name || '').slice(0, 60) || 'PC',
        clientId: sameServer ? this.state.clientId : crypto.randomUUID(), seq: sameServer ? this.state.seq : 0, cursor: sameServer ? this.state.cursor : 0, synced: sameServer ? this.state.synced : false });
      if (!sameServer) await this.db.clearPending();
      this.db.sync = true;
    });
    this.backoff = 1000; this.connect();
    return this.info();
  }
  async disable() {
    // 로컬 모드: 연결만 끊고 대기열 기록은 계속(this.db.sync 유지). 다시 켜면 쌓인 변경을 먼저 올린 뒤 서버 변경을 받는다.
    await this.serial(async () => { this.close(); if (this.state) await this.saveState({ enabled: false }); });
    this.setStatus('off'); return this.info();
  }
  async resync() { await this.serial(() => this.saveState({ cursor: 0, synced: false })); this.connect(); return this.info(); }
  close() { this.source?.close(); this.source = null; clearTimeout(this.retryTimer); clearTimeout(this.pushTimer); }

  async request(method, path = '', body) {
    const res = await this.fetchImpl(this.state.url + path, { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body, wellFormed) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }
  async send(changes) {
    const body = seq => ({ client_id: this.state.clientId, name: this.state.name, sequence: seq, changes });
    try { return await this.request('POST', '', body(this.state.seq + 1)); }
    catch (e) {
      const expected = /expected=(\d+)/.exec(e.message || '');
      if (e.status !== 409 || !expected) throw e;
      this.state.seq = Number(expected[1]) - 1;
      return this.request('POST', '', body(this.state.seq + 1));
    }
  }
  // 처음 연결: 캐시 전체를 merge로 올린다(대기열과 별개, 묶음 200개)
  async uploadAll() {
    const { items } = await this.db.snapshot();
    for (let i = 0; i < items.length; i += 200) {
      await this.send(items.slice(i, i + 200).map(item => ({ op: 'merge', item })));
      await this.saveState({ seq: this.state.seq + 1 });
    }
  }
  async push() {
    for (;;) {
      const batch = await this.db.pending(200);
      if (!batch.length) return;
      const r = await this.send(batch.map(e => e.change));
      this.state = { ...this.state, seq: this.state.seq + 1 };
      await this.db.ack(batch.map(e => e.seq), this.state);
      // 서버 반영 기록: 서버가 묶음을 적용하고 성공을 돌려준 뒤에만 남긴다(알림 없음, 기록만).
      this.log({ kind: 'push', ok: true, sent: batch.length, sequence: this.state.seq, rev: r?.rev, added: r?.added, skipped: r?.skipped, invalid: r?.invalid, duplicate: !!r?.duplicate });
    }
  }
  async pull(replace = false) {
    let cursor = replace ? 0 : this.state.cursor || 0; const all = []; let changed = 0;
    for (;;) {
      const page = await this.request('GET', `?after=${cursor}`);
      cursor = page.next;
      if (replace) all.push(...page.changes);
      else if (page.changes.length) { this.state = { ...this.state, cursor }; changed += await this.exclusive(() => this.db.applyRemote(page.changes, this.state)); }
      if (!page.has_more) break;
    }
    if (replace) { this.state = { ...this.state, cursor, synced: true }; changed += await this.exclusive(() => this.db.applyRemote(all.filter(r => r.item), this.state, { replace: true })); }
    else if (this.state.cursor !== cursor) await this.saveState({ cursor });
    this.lastSync = Date.now();
    if (changed) this.onChange();
  }
  catchUp() {
    return this.serial(async () => {
      if (!this.state?.enabled) return;
      if (!this.state.synced) { await this.uploadAll(); await this.push(); await this.pull(true); }
      else { await this.push(); await this.pull(); }
    });
  }
  // 1초 묶음을 기다리지 않고 바로 올린다. 끝나기를 기다리지 않는다(결과는 기록에만).
  flush() {
    if (!this.state?.enabled) return;
    clearTimeout(this.pushTimer);
    void this.serial(() => this.push()).then(() => this.onStatus(this.info()), e => this.failed(e));
  }
  schedulePush() {
    if (!this.state?.enabled) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.serial(() => this.push()).then(() => this.onStatus(this.info()), e => this.failed(e)), this.delay);
    void this.info().then(i => this.onStatus(i));
  }
  failed(e) {
    if (!this.state?.enabled) return;
    this.log({ kind: 'push', ok: false, status: e?.status || null, error: e?.message || '연결 실패' });
    if (e?.status === 401) { this.close(); this.setStatus('unauthorized', '서버 주소(토큰)가 바뀌었거나 연동이 꺼졌습니다. 새 주소를 넣으세요.'); return; }
    this.close(); this.setStatus('offline', e?.message || '연결 실패');
    this.retryTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.maxBackoff, this.backoff * 2);
  }
  connect() {
    if (!this.state?.enabled) return;
    this.close(); this.setStatus('connecting');
    void this.catchUp().then(() => {
      if (!this.state?.enabled) return;
      const source = this.source = new this.ES(this.state.url + '/events');
      source.addEventListener('vault', event => { if (Number(event.data) > (this.state.cursor || 0)) void this.serial(() => this.pull()).catch(e => this.failed(e)); });
      let opened = false;
      source.onopen = () => { this.backoff = 1000; this.setStatus('connected'); if (opened) void this.catchUp().catch(e => this.failed(e)); opened = true; };
      source.onerror = () => { if (this.source !== source) return; this.setStatus('offline', '실시간 연결이 끊겨 다시 연결 중'); if (source.readyState === 2) this.failed(new Error('실시간 연결 종료')); };
      this.setStatus('connected');
    }, e => this.failed(e));
  }
}

// FC@nyaa 연동: 같은 PC에서 도는 nyaa.exe(127.0.0.1:18232)와 주고받는다.
// 예전 유저스크립트(FC2 Player Controller)와 AHK(FC@nyaa.ahk)의 브라우저 쪽 일을 맡는다.
//   - nyaa → 확장: GET /events (SSE) 명령 { id, type: extract | close-tab | restore-tab | media }
//   - 확장 → nyaa: POST /extracted, POST /result (명령의 답), POST /viewed (supjav 열람 기록)
// 설정(켜짐·주소)은 이 PC 전용이라 백그라운드 localStorage에 둔다(보관함 백업에 들어가지 않음).
// 계획서: hitomi-web/fc-nyaa/docs/merge-plan.md

export const DEFAULT_URL = 'http://127.0.0.1:18232';
const KEY = 'fc-nyaa';
const LOG_MAX = 50;

import { extractCode } from './code.js';
// 품번 추출: code.js(AHK 규칙, 제목만)와 같은 함수.
export const extractQuery = title => extractCode(title);
export const isSupjav = url => { try { const h = new URL(url).hostname; return h === 'supjav.com' || h.endsWith('.supjav.com'); } catch { return false; } };

// 탭의 모든 프레임(플레이어 iframe 포함)에 넣는 영상 제어 코드. 숨긴 탭에서는 재생하지 않는다(유저스크립트와 같음).
export function mediaScript(action) {
  return `(() => { const cmd = ${JSON.stringify(action)}; const hidden = document.visibilityState === 'hidden'; let n = 0;
    for (const v of document.querySelectorAll('video')) { n++;
      if (cmd === 'pause' && !v.paused) v.pause();
      else if (cmd === 'play' && v.paused && !hidden) v.play().catch(() => {});
      else if (cmd === 'toggle') { if (v.paused && !hidden) v.play().catch(() => {}); else if (!v.paused) v.pause(); } }
    return n; })()`;
}

export class FcNyaa {
  constructor({ browser, fetch = (...a) => globalThis.fetch(...a), EventSource = globalThis.EventSource, storage = globalThis.localStorage, onStatus = () => {}, closeDone = null, onDownloaded = async () => false, maxBackoff = 30000 } = {}) {
    Object.assign(this, { browser, fetchImpl: fetch, ES: EventSource, storage, onStatus, closeDone, onDownloaded, maxBackoff });
    this.settings = this.load();
    this.status = 'off'; this.error = ''; this.version = ''; this.source = null; this.retry = null; this.backoff = 1000;
    this.viewed = new Map(); // tabId → 마지막으로 기록한 주소 (같은 페이지 중복 기록 방지)
    this.log = [];
  }
  load() { try { return { enabled: false, url: DEFAULT_URL, ...JSON.parse(this.storage?.getItem(KEY) || '{}') }; } catch { return { enabled: false, url: DEFAULT_URL }; } }
  save() { try { this.storage?.setItem(KEY, JSON.stringify(this.settings)); } catch { /* 저장 실패는 무시 */ } }
  info() { return { enabled: this.settings.enabled, url: this.settings.url, status: this.status, error: this.error, version: this.version, log: this.log.slice(-20).reverse() }; }
  note(text, ok = true) { this.log.push({ at: Date.now(), text, ok }); if (this.log.length > LOG_MAX) this.log.shift(); }
  setStatus(status, error = '') { this.status = status; this.error = error; this.onStatus(this.info()); }

  start() { if (this.settings.enabled) this.connect(); else this.setStatus('off'); }
  configure({ enabled, url } = {}) {
    const next = String(url ?? this.settings.url).trim().replace(/\/+$/, '') || DEFAULT_URL;
    if (!/^https?:\/\/[^/?#]+$/i.test(next)) throw new Error('nyaa 주소는 http://127.0.0.1:18232 형식이어야 합니다.');
    this.settings = { enabled: !!enabled, url: next }; this.save();
    this.close(); this.backoff = 1000;
    if (this.settings.enabled) this.connect(); else this.setStatus('off');
    return this.info();
  }
  close() { this.source?.close(); this.source = null; clearTimeout(this.retry); this.retry = null; }
  connect() {
    this.close();
    if (!this.ES) { this.setStatus('offline', 'EventSource 없음'); return; }
    this.setStatus('connecting');
    const es = new this.ES(`${this.settings.url}/events`);
    this.source = es;
    es.onmessage = event => {
      let cmd; try { cmd = JSON.parse(event.data); } catch { return; }
      if (cmd.type === 'hello') { this.version = cmd.version || ''; this.backoff = 1000; this.setStatus('connected'); return; }
      void this.handle(cmd);
    };
    es.onerror = () => {
      if (this.source !== es) return;
      es.close(); this.source = null;
      this.setStatus('offline', 'nyaa.exe에 연결되지 않음 · 다시 연결 중');
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    };
  }

  async post(path, body) {
    const res = await this.fetchImpl(`${this.settings.url}${path}`, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }

  // 마지막으로 포커스된 일반 창의 현재 탭 (브라우저가 앞에 없어도 된다)
  async activeTab() {
    const win = await this.browser.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
    const tab = win?.tabs?.find(t => t.active);
    if (!tab) throw new Error('브라우저 탭을 찾지 못했습니다');
    if (tab.incognito) throw new Error('사생활 보호 창은 쓰지 않습니다');
    return tab;
  }

  async media(action, tabs) {
    const targets = tabs || (await this.browser.tabs.query({})).filter(t => !t.incognito && isSupjav(t.url));
    let videos = 0;
    for (const tab of targets) {
      const r = await this.browser.tabs.executeScript(tab.id, { allFrames: true, code: mediaScript(action) }).catch(() => []);
      videos += (r || []).reduce((a, n) => a + (Number(n) || 0), 0);
    }
    return { tabs: targets.length, videos };
  }

  async handle(cmd) {
    const id = cmd.id;
    try {
      if (cmd.type === 'extract') {
        const tab = await this.activeTab();
        const query = extractQuery(tab.title);
        if (query && cmd.pause) await this.media('pause', [tab]);
        this.note(query ? `추출 ${query}${cmd.slot ? ` (슬롯 ${cmd.slot})` : ''}` : `품번 없음: ${tab.title || tab.url}`, !!query);
        await this.post('/extracted', { id, query, title: tab.title || '', url: tab.url || '', tabId: tab.id });
      } else if (cmd.type === 'close-tab') {
        const tab = await this.activeTab();
        await (this.closeDone ? this.closeDone(tab.id) : this.browser.tabs.remove(tab.id));
        this.note('탭 닫기');
        await this.post('/result', { id, ok: true });
      } else if (cmd.type === 'downloaded') {
        // 슬롯으로 받은 탭의 다운로드가 걸림 → 보관함 작업이면 완료로 닫고 다음 항목 (탭 작업이면 아무것도 안 함)
        const closed = await this.onDownloaded(cmd.tabId);
        if (closed) this.note('다운로드 완료 · 탭 닫고 다음 항목');
        await this.post('/result', { id, ok: true });
      } else if (cmd.type === 'restore-tab') {
        const restored = await this.browser.sessions.restore();
        this.note('탭 복구', !!restored);
        await this.post('/result', { id, ok: !!restored, message: restored ? '' : '복구할 탭이 없습니다' });
      } else if (cmd.type === 'media') {
        const r = await this.media(cmd.action || 'toggle');
        const ok = r.videos > 0;
        this.note(`영상 ${cmd.action || 'toggle'} · supjav 탭 ${r.tabs}개 · 영상 ${r.videos}개`, ok);
        await this.post('/result', { id, ok, message: ok ? '' : r.tabs ? '영상을 찾지 못했습니다(관리 화면에서 영상 제어 권한을 허용했는지 확인)' : 'supjav 탭이 없습니다' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.note(`${cmd.type} 실패: ${message}`, false);
      const path = cmd.type === 'extract' ? '/extracted' : '/result';
      await this.post(path, cmd.type === 'extract' ? { id, query: null, error: message } : { id, ok: false, message }).catch(() => {});
    }
  }

  // supjav 페이지가 다 열리면 열람 기록 (유저스크립트 extractAndSendViewed와 같음)
  async onTabUpdated(tabId, change, tab) {
    if (!this.settings.enabled || change.status !== 'complete' || !tab || tab.incognito || !isSupjav(tab.url)) return null;
    if (this.viewed.get(tabId) === tab.url) return null;
    const query = extractQuery(tab.title);
    if (!query) return null;
    this.viewed.set(tabId, tab.url);
    try { await this.post('/viewed', { query, source: 'supjav' }); this.note(`열람 기록 ${query}`); }
    catch (error) { this.viewed.delete(tabId); this.note(`열람 기록 실패 ${query}: ${error instanceof Error ? error.message : error}`, false); }
    return query;
  }
  onTabRemoved(tabId) { this.viewed.delete(tabId); }
}

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { VaultDB, diffItem } from '../extension/db.js';
import { ServerSync, parseAddress } from '../extension/sync.js';

const TOKEN = 'a'.repeat(64);
const URL_ = `http://nas:4824/api/vault/${TOKEN}`;
let n = 0;
const item = (id, url, extra = {}) => ({ id, url, title: id, status: 'unread', note: '', tags: [], createdAt: 1, updatedAt: 1, lastViewedAt: null, completedAt: null, deletedAt: null, warning: false, sources: [], ...extra });

// Rust vault.rs와 같은 규칙의 가짜 서버
function server() {
  const s = { items: new Map(), rev: 0, clients: new Map(), down: false, sources: new Set() };
  const write = (id, value) => { s.items.set(id, { item: value, rev: ++s.rev }); };
  s.fetch = async (url, init = {}) => {
    if (s.down) throw new TypeError('NetworkError');
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (!url.startsWith(URL_)) return json(401, { error: 'bad token' });
    if (init.method === 'POST') {
      const p = JSON.parse(init.body), last = s.clients.get(p.client_id) || 0;
      if (p.sequence <= last) return json(200, { rev: s.rev, duplicate: true });
      if (p.sequence !== last + 1) return json(409, { error: `expected=${last + 1}` });
      const before = s.rev;
      for (const c of p.changes) {
        const cur = s.items.get(c.id || c.item.id)?.item;
        if (c.op === 'add') write(c.item.id, { ...cur, ...c.item });
        if (c.op === 'merge' && !cur && ![...s.items.values()].some(r => r.item && r.item.url === c.item.url)) write(c.item.id, c.item);
        if (c.op === 'patch' && cur) write(c.id, { ...cur, ...c.fields });
        if (c.op === 'delete' && cur) write(c.id, null);
      }
      s.clients.set(p.client_id, p.sequence);
      if (s.rev !== before) for (const es of s.sources) es.emit(s.rev);
      return json(200, { rev: s.rev });
    }
    const after = Number(new URL(url).searchParams.get('after') || 0);
    const rows = [...s.items].filter(([, r]) => r.rev > after).sort((a, b) => a[1].rev - b[1].rev).map(([id, r]) => ({ id, item: r.item, rev: r.rev }));
    return json(200, { changes: rows, next: rows.at(-1)?.rev ?? after, has_more: false });
  };
  s.EventSource = class { constructor() { this.readyState = 1; this.handlers = {}; s.sources.add(this); queueMicrotask(() => this.onopen?.()); }
    addEventListener(t, f) { this.handlers[t] = f; } emit(rev) { this.handlers.vault?.({ data: String(rev) }); } close() { this.readyState = 2; s.sources.delete(this); } };
  return s;
}
async function pc(s, items = []) {
  const db = new VaultDB(`sync-${n++}`);
  if (items.length) await db.commit({ items });
  const sync = new ServerSync(db, { fetch: s.fetch, EventSource: s.EventSource, delay: 1, maxBackoff: 5 });
  await sync.start();
  return { db, sync };
}
const settle = async (sync) => { for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 5)); await sync.tail; } };
const titles = async db => (await db.snapshot()).items.map(i => `${i.id}:${i.status}:${i.note}`).sort();

test('address parsing and field diffs', () => {
  assert.equal(parseAddress(URL_ + '/').url, URL_);
  assert.equal(parseAddress(`http://nas/api/${TOKEN}`), null);
  assert.deepEqual(diffItem(null, item('1', 'u')), { op: 'add', item: item('1', 'u') });
  assert.deepEqual(diffItem(null, item('1', 'u'), 'merge').op, 'merge');
  assert.deepEqual(diffItem(item('1', 'u'), item('1', 'u', { status: 'done' })), { op: 'patch', id: '1', fields: { status: 'done' } });
  assert.equal(diffItem(item('1', 'u'), item('1', 'u')), null);
});

test('two PCs share the server vault in real time; first connect merges by URL', async () => {
  const s = server();
  const a = await pc(s, [item('a1', 'https://x/1'), item('a2', 'https://x/2')]);
  await a.sync.configure({ url: URL_, name: 'PC A' }); await settle(a.sync);
  assert.equal(s.items.size, 2);
  const b = await pc(s, [item('b1', 'https://x/1'), item('b9', 'https://x/9')]);
  await b.sync.configure({ url: URL_, name: 'PC B' }); await settle(b.sync); await settle(a.sync);
  // 같은 URL(b1)은 서버 것(a1) 유지, 새 URL(b9)은 추가, B 캐시는 서버 기준으로 맞춰짐
  assert.deepEqual(await titles(b.db), ['a1:unread:', 'a2:unread:', 'b9:unread:']);
  assert.deepEqual(await titles(a.db), ['a1:unread:', 'a2:unread:', 'b9:unread:']);
  // A에서 완료, B에서 메모 → 다른 칸은 둘 다 유지
  const [a1] = (await a.db.snapshot()).items.filter(i => i.id === 'a1');
  await a.db.commit({ items: [{ ...a1, status: 'done' }] });
  await settle(a.sync); await settle(b.sync);
  const [b1] = (await b.db.snapshot()).items.filter(i => i.id === 'a1');
  await b.db.commit({ items: [{ ...b1, note: 'memo' }] });
  await settle(a.sync); await settle(b.sync); await settle(a.sync);
  assert.deepEqual(s.items.get('a1').item.status, 'done');
  assert.deepEqual(s.items.get('a1').item.note, 'memo');
  assert.ok((await titles(a.db)).includes('a1:done:memo'));
  assert.ok((await titles(b.db)).includes('a1:done:memo'));
  a.sync.close(); b.sync.close();
});

test('offline changes queue locally and upload after reconnect; remote writes are not echoed', async () => {
  const s = server();
  const a = await pc(s, [item('1', 'https://x/1')]);
  await a.sync.configure({ url: URL_, name: 'A' }); await settle(a.sync);
  s.down = true;
  const [one] = (await a.db.snapshot()).items;
  await a.db.commit({ items: [{ ...one, status: 'done' }, item('2', 'https://x/2')] });
  await settle(a.sync);
  assert.equal(await a.db.countPending(), 2);
  assert.equal((await a.sync.info()).status, 'offline');
  s.down = false;
  for (let i = 0; i < 10 && await a.db.countPending(); i++) await settle(a.sync);
  assert.equal(await a.db.countPending(), 0);
  assert.equal(s.items.get('1').item.status, 'done');
  assert.ok(s.items.has('2'));
  const seqBefore = s.clients.get(a.sync.state.clientId);
  await a.db.applyRemote([{ id: '3', item: item('3', 'https://x/3'), rev: 99 }], a.sync.state);
  await settle(a.sync);
  assert.equal(s.clients.get(a.sync.state.clientId), seqBefore);
  a.sync.close();
});

test('wrong token stops syncing', async () => {
  const s = server();
  const a = await pc(s, [item('1', 'https://x/1')]);
  await a.sync.configure({ url: `http://nas:4824/api/vault/${'b'.repeat(64)}`, name: 'A' }); await settle(a.sync);
  assert.equal((await a.sync.info()).status, 'unauthorized');
  a.sync.close();
});

test('local mode keeps queueing edits; turning sync back on uploads them before taking server changes', async () => {
  const s = server();
  const a = await pc(s, [item('1', 'https://x/1'), item('2', 'https://x/2')]);
  await a.sync.configure({ url: URL_, name: 'A' }); await settle(a.sync);
  assert.equal(s.items.get('1').item.status, 'unread');
  await a.sync.disable();
  assert.equal((await a.sync.info()).status, 'off');
  const snap = (await a.db.snapshot()).items, one = snap.find(i => i.id === '1');
  await a.db.commit({ items: [{ ...one, status: 'done', note: '로컬' }, item('3', 'https://x/3')] }, { items: ['2'] });
  await settle(a.sync);
  assert.equal(await a.db.countPending(), 3, '로컬 모드 변경도 대기열에 남음');
  assert.equal(s.items.get('1').item.status, 'unread', '로컬 모드에서는 서버로 보내지 않음');
  const restarted = new ServerSync(a.db, { fetch: s.fetch, EventSource: s.EventSource, delay: 1, maxBackoff: 5 });
  await restarted.start(); // 재시작해도 로컬 모드 기록 유지
  await a.db.commit({ items: [{ ...(await a.db.snapshot()).items.find(i => i.id === '3'), note: 'after restart' }] });
  assert.equal(await a.db.countPending(), 4);
  await restarted.configure({ url: URL_, name: 'A' });
  for (let i = 0; i < 10 && await a.db.countPending(); i++) await settle(restarted);
  assert.equal(await a.db.countPending(), 0);
  assert.equal(s.items.get('1').item.status, 'done'); assert.equal(s.items.get('1').item.note, '로컬');
  assert.equal(s.items.get('2').item, null, '로컬 모드 삭제도 반영');
  assert.equal(s.items.get('3').item.note, 'after restart');
  assert.deepEqual(await titles(a.db), ['1:done:로컬', '3:unread:after restart']);
  restarted.close();
});
test('broken emoji in titles is sent as valid JSON for the server', async () => {
  const { wellFormed } = await import('../extension/sync.js');
  const text = JSON.stringify({ title: 'tab \uD83D', ok: '😀' }, wellFormed);
  assert.doesNotMatch(text, /\ud83d"/i);
  assert.equal(JSON.parse(text).title, 'tab �');
  assert.equal(JSON.parse(text).ok, '😀');
});

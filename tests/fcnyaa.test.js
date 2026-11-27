import test from 'node:test';
import assert from 'node:assert/strict';
import { extractQuery, isSupjav, mediaScript, FcNyaa, DEFAULT_URL } from '../extension/fcnyaa.js';

test('품번 추출: AHK·유저스크립트와 같은 규칙', () => {
  assert.equal(extractQuery('一本道 112624_001 제목'), '112624_001-1PON');
  assert.equal(extractQuery('x', 'https://www.1pondo.tv/movies/112624_001/'), null); // 제목만 본다(AHK와 같음)
  assert.equal(extractQuery('10musume 112624_01'), '112624_01-10MU');
  assert.equal(extractQuery('カリビアンコム 112624-123'), '112624-123-CARIB');
  assert.equal(extractQuery('pacopacomama 112624_123'), '112624_123-PACO');
  assert.equal(extractQuery('HEYZO 3456 title'), 'HEYZO 3456');
  assert.equal(extractQuery('heyzo-3456'), null); // 공백 필요 (AHK와 같음)
  assert.equal(extractQuery('FC2-PPV-4834815 제목'), '4834815');
  assert.equal(extractQuery('FC2 12345678901'), null); // 11자리는 아님
  assert.equal(extractQuery('그냥 제목 1234567'), null); // fc2 단어 없으면 숫자만으로는 안 뽑음
});

test('supjav 주소 판별', () => {
  assert.ok(isSupjav('https://supjav.com/ja/123.html'));
  assert.ok(isSupjav('https://www.supjav.com/x'));
  assert.ok(!isSupjav('https://notsupjav.com/'));
  assert.ok(!isSupjav('about:blank'));
});

test('영상 제어 코드는 동작 이름을 문자열로 넣는다', () => {
  assert.match(mediaScript('toggle'), /const cmd = "toggle"/);
  assert.match(mediaScript('pause'), /visibilityState/);
});

function memoryStorage() { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; }

function fakeBrowser({ tab, supjavTabs = [] } = {}) {
  const calls = { removed: [], restored: 0, scripts: [] };
  return {
    calls,
    windows: { getLastFocused: async () => ({ tabs: [{ id: 9, active: false }, tab] }) },
    tabs: {
      remove: async id => { calls.removed.push(id); },
      query: async () => supjavTabs,
      executeScript: async (id, opts) => { calls.scripts.push({ id, code: opts.code, allFrames: opts.allFrames }); return [1]; },
    },
    sessions: { restore: async () => { calls.restored++; return { tab: { id: 3 } }; } },
  };
}

function fakeFetch() {
  const posts = [];
  const fetch = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ status: 'ok' }) }; };
  return { posts, fetch };
}

test('extract 명령: 현재 탭에서 품번을 뽑아 /extracted로 답하고, pause면 그 탭 영상을 멈춘다', async () => {
  const browser = fakeBrowser({ tab: { id: 5, active: true, title: 'HEYZO 1234 - supjav', url: 'https://supjav.com/ja/1.html' } });
  const { posts, fetch } = fakeFetch();
  const fc = new FcNyaa({ browser, fetch, storage: memoryStorage() });
  await fc.handle({ id: 7, type: 'extract', slot: 2, pause: true });
  assert.deepEqual(posts[0], { url: `${DEFAULT_URL}/extracted`, body: { id: 7, query: 'HEYZO 1234', title: 'HEYZO 1234 - supjav', url: 'https://supjav.com/ja/1.html', tabId: 5 } });
  assert.equal(browser.calls.scripts.length, 1);
  assert.equal(browser.calls.scripts[0].id, 5);
  assert.ok(browser.calls.scripts[0].allFrames);
  assert.match(browser.calls.scripts[0].code, /"pause"/);
});

test('extract 명령: 품번이 없으면 query null, 영상은 건드리지 않는다', async () => {
  const browser = fakeBrowser({ tab: { id: 5, active: true, title: '일반 페이지', url: 'https://example.com/' } });
  const { posts, fetch } = fakeFetch();
  const fc = new FcNyaa({ browser, fetch, storage: memoryStorage() });
  await fc.handle({ id: 1, type: 'extract', pause: true });
  assert.equal(posts[0].body.query, null);
  assert.equal(browser.calls.scripts.length, 0);
});

test('사생활 보호 창 탭은 쓰지 않고 오류로 답한다', async () => {
  const browser = fakeBrowser({ tab: { id: 5, active: true, incognito: true, title: 'HEYZO 1234', url: 'https://supjav.com/' } });
  const { posts, fetch } = fakeFetch();
  const fc = new FcNyaa({ browser, fetch, storage: memoryStorage() });
  await fc.handle({ id: 2, type: 'extract' });
  assert.equal(posts[0].url, `${DEFAULT_URL}/extracted`);
  assert.equal(posts[0].body.query, null);
  assert.match(posts[0].body.error, /사생활/);
});

test('탭 닫기·복구·영상 명령', async () => {
  const supjavTabs = [{ id: 11, url: 'https://supjav.com/a' }, { id: 12, url: 'https://example.com/' }, { id: 13, url: 'https://supjav.com/b', incognito: true }];
  const browser = fakeBrowser({ tab: { id: 5, active: true, title: 't', url: 'https://supjav.com/' }, supjavTabs });
  const { posts, fetch } = fakeFetch();
  const fc = new FcNyaa({ browser, fetch, storage: memoryStorage() });
  await fc.handle({ id: 3, type: 'close-tab' });
  await fc.handle({ id: 4, type: 'restore-tab' });
  await fc.handle({ id: 5, type: 'media', action: 'toggle' });
  assert.deepEqual(browser.calls.removed, [5]);
  assert.equal(browser.calls.restored, 1);
  assert.deepEqual(browser.calls.scripts.map(s => s.id), [11]); // supjav 일반 탭만
  assert.deepEqual(posts.map(p => [p.url.replace(DEFAULT_URL, ''), p.body.id, p.body.ok]), [['/result', 3, true], ['/result', 4, true], ['/result', 5, true]]);
});

test('supjav 열람 기록: 켜져 있을 때만, 같은 탭 같은 주소는 한 번만', async () => {
  const { posts, fetch } = fakeFetch();
  const storage = memoryStorage();
  const fc = new FcNyaa({ browser: fakeBrowser(), fetch, storage });
  const tab = { id: 1, title: 'FC2-PPV-4834815', url: 'https://supjav.com/ja/4834815.html' };
  assert.equal(await fc.onTabUpdated(1, { status: 'complete' }, tab), null); // 꺼짐
  fc.settings.enabled = true;
  assert.equal(await fc.onTabUpdated(1, { status: 'loading' }, tab), null);
  assert.equal(await fc.onTabUpdated(1, { status: 'complete' }, tab), '4834815');
  assert.equal(await fc.onTabUpdated(1, { status: 'complete' }, tab), null); // 중복
  assert.equal(await fc.onTabUpdated(2, { status: 'complete' }, { id: 2, title: 'HEYZO 1234', url: 'https://example.com/' }), null); // supjav 아님
  assert.deepEqual(posts, [{ url: `${DEFAULT_URL}/viewed`, body: { query: '4834815', source: 'supjav' } }]);
});

test('설정: 주소 형식 검사, 이 PC 저장소에 보관, SSE 연결과 hello로 연결됨', () => {
  const storage = memoryStorage();
  const sources = [];
  class ES { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } }
  const statuses = [];
  const fc = new FcNyaa({ browser: fakeBrowser(), fetch: async () => ({ ok: true, json: async () => ({}) }), EventSource: ES, storage, onStatus: i => statuses.push(i.status) });
  assert.throws(() => fc.configure({ enabled: true, url: 'ftp://x' }), /형식/);
  const info = fc.configure({ enabled: true, url: 'http://127.0.0.1:18232/' });
  assert.equal(info.url, 'http://127.0.0.1:18232');
  assert.equal(sources.at(-1).url, 'http://127.0.0.1:18232/events');
  sources.at(-1).onmessage({ data: JSON.stringify({ type: 'hello', version: '0.9.3' }) });
  assert.equal(fc.info().status, 'connected');
  assert.equal(fc.info().version, '0.9.3');
  assert.deepEqual(JSON.parse(storage.getItem('fc-nyaa')), { enabled: true, url: 'http://127.0.0.1:18232' });
  // 새 인스턴스(백그라운드 재시작)도 설정을 기억
  assert.equal(new FcNyaa({ browser: fakeBrowser(), storage }).settings.enabled, true);
  fc.configure({ enabled: false });
  assert.equal(fc.info().status, 'off');
  assert.ok(sources.at(-1).closed);
  assert.ok(statuses.includes('connecting'));
});

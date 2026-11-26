import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseList, isChallenge, pageUrl, listPage, Collector, CollectorDB, LIST_URL, currentTabLoader } from '../extension/collector.js';
import { describeRun } from '../extension/supjav-text.js';

const parse = html => new JSDOM(html).window.document;
const post = (id, title, { date = '2026/11/24', thumb = `https://img.supjav.com/images/X-${id}.jpg!320x216.jpg` } = {}) =>
  `<div class="post"><a class="img" href="https://supjav.com/ja/${id}.html" title="${title}"><img class="thumb" data-original="${thumb}" src="${thumb}" alt="${title}"></a><div class="con"><h3><a href="https://supjav.com/ja/${id}.html">${title}</a></h3><div class="meta">${date}<span class="date">1234 Views</span></div></div></div>`;
// ids: 숫자 또는 [id, 'YYYY/MM/DD']
const page = ids => `<html><head><title>無修正 - Supjav.com</title></head><body>${ids.map(x => Array.isArray(x) ? post(x[0], `タイトル ${x[0]}`, { date: x[1] }) : post(x, `タイトル ${x}`)).join('')}</body></html>`;
const challenge = '<html><head><title>Just a moment...</title></head><body><div id="challenge-error-text"></div></body></html>';
let dbCount = 0;
const collector = () => new Collector(new CollectorDB(`test-${dbCount++}`), { parse, delay: async () => {}, now: () => 1000 });
// 쪽 번호별 HTML을 돌려주는 가짜 탭 로더
function pages(map, calls = []) {
  return { calls, async load(url) { calls.push(url); const n = listPage(url); const body = map[n]; if (body === undefined) return { ok: true, status: null, html: '<title>404</title><body></body>' }; return { ok: true, status: null, html: body }; } };
}

test('parseList reads Japanese list cards', () => {
  const posts = parseList(parse(`<body>${post(475015, 'FC2PPV 5013443 ※【初・無】交際ｸﾗﾌﾞ')}${post(475016, '二番目', { date: '2026/11/23' })}</body>`));
  assert.deepEqual(posts[0], { id: '475015', url: 'https://supjav.com/ja/475015.html', title: 'FC2PPV 5013443 ※【初・無】交際ｸﾗﾌﾞ', thumb: 'https://img.supjav.com/images/X-475015.jpg!320x216.jpg', date: '2026-11-24' });
  assert.equal(posts[1].date, '2026-11-23');
});

test('parseList rejects foreign links/thumbnails, strips query strings and skips duplicates', () => {
  const html = `<body>
    <div class="post"><a class="img" href="https://evil.example/1.html" title="x"><img src="https://img.supjav.com/a.jpg"></a></div>
    ${post(474931, 'Query', { thumb: 'https://cdn.example/t.jpg' }).replace('474931.html"', '474931.html?ref=1#top"')}
    ${post(474931, 'Dup')}
  </body>`;
  const posts = parseList(parse(html));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://supjav.com/ja/474931.html');
  assert.equal(posts[0].thumb, null);
});

test('list page detection is Japanese-only and page urls keep /ja/', () => {
  assert.equal(listPage('https://supjav.com/ja/category/uncensored-jav'), 1);
  assert.equal(listPage('https://supjav.com/ja/category/uncensored-jav/page/7?x=1'), 7);
  assert.equal(listPage('https://supjav.com/category/uncensored-jav'), null);
  assert.equal(listPage('https://supjav.com/ja/475015.html'), null);
  assert.equal(pageUrl(1), LIST_URL);
  assert.equal(pageUrl(3), 'https://supjav.com/ja/category/uncensored-jav/page/3');
  assert.equal(isChallenge(403, parse('<title>x</title>')), true);
  assert.equal(isChallenge(null, parse(challenge)), true);
  assert.equal(isChallenge(null, parse(page([1]))), false);
});

test('new-only mode starts at the current page and stops at a page without new posts', async () => {
  const c = collector();
  const site = { 1: page([10, 9]), 2: page([8, 7]), 3: page([6, 5]) };
  const first = await c.collect({ loader: pages(site), maxPages: 2 });
  assert.equal(first.added, 4); assert.equal(first.reason, 'limit'); assert.equal(first.lastPage, 2);
  site[1] = page([12, 11]); site[2] = page([10, 9]);
  const calls = [];
  const second = await c.collect({ loader: pages(site, calls), maxPages: 10 });
  assert.equal(second.added, 2); assert.equal(second.reason, 'caught-up'); assert.equal(calls.length, 2);
  const fromThree = await c.collect({ loader: pages(site), startPage: 3, maxPages: 5 });
  assert.equal(fromThree.added, 2); assert.equal(fromThree.lastPage, 4);
  assert.deepEqual((await c.list()).posts.map(p => p.id), ['12', '11', '10', '9', '8', '7', '6', '5']);
});

test('date mode keeps posts on or after the date and stops at the first older post', async () => {
  const c = collector();
  const site = { 1: page([[20, '2026/11/25'], [19, '2026/11/24']]), 2: page([[18, '2026/11/23'], [17, '2026/11/22']]), 3: page([[16, '2026/11/21']]) };
  const calls = [];
  const r = await c.collect({ loader: pages(site, calls), mode: 'date', untilDate: '2026-11-23' });
  assert.equal(r.reason, 'date-reached'); assert.equal(r.added, 3); assert.equal(calls.length, 2);
  assert.deepEqual((await c.list()).posts.map(p => p.id), ['20', '19', '18']);
  await assert.rejects(c.collect({ loader: pages(site), mode: 'date' }), /날짜/);
  assert.match(describeRun(r), /2026-11-23까지/);
});

test('stop request ends after the current page; challenge and structure reasons are reported', async () => {
  const c = collector();
  const site = { 1: page([3]), 2: page([2]), 3: page([1]) };
  const loader = pages(site);
  const orig = loader.load;
  loader.load = async url => { const r = await orig.call(loader, url); c.stop(); return r; };
  const r = await c.collect({ loader, maxPages: 3 });
  assert.equal(r.reason, 'stopped'); assert.equal(r.pages, 1);
  assert.equal((await collector().collect({ loader: pages({ 1: challenge }) })).reason, 'challenge');
  assert.equal((await collector().collect({ loader: pages({ 1: '<title>ok</title><body>nothing</body>' }) })).reason, 'structure');
});

test('updates changed titles and blocks concurrent runs', async () => {
  const c = collector();
  const site = { 1: page([5]) };
  await c.collect({ loader: pages(site), maxPages: 1 });
  site[1] = page([5]).replace(/タイトル 5/g, '改名 5');
  const r = await c.collect({ loader: pages(site), maxPages: 1 });
  assert.equal(r.updated, 1);
  assert.equal((await c.list()).posts[0].title, '改名 5');
  const running = c.collect({ loader: pages(site), maxPages: 1 });
  await assert.rejects(c.collect({ loader: pages(site) }), /이미 수집 중/);
  await running;
});

function fakeTab(startUrl, views) {
  const listeners = { updated: new Set(), removed: new Set() };
  const tab = { id: 7, url: startUrl, status: 'complete' }; let alive = true; const log = [];
  const api = { tabs: {
    onUpdated: { addListener: f => listeners.updated.add(f), removeListener: f => listeners.updated.delete(f) },
    onRemoved: { addListener: f => listeners.removed.add(f), removeListener: f => listeners.removed.delete(f) },
    async get(id) { if (!alive || id !== 7) throw new Error('gone'); return { ...tab }; },
    async update(id, props) { log.push(['update', props]); if (props.url) { tab.url = props.url; tab.status = 'loading'; setTimeout(() => { tab.status = 'complete'; listeners.updated.forEach(f => f(7, { status: 'complete' })); }, 1); } return { ...tab }; },
    async executeScript() { const v = views[tab.url]; return [typeof v === 'function' ? v() : v]; },
    async create() { throw new Error('must not open a new tab'); },
    async remove() { throw new Error('must not close the tab'); }
  } };
  return { api, tab, log, close() { alive = false; listeners.removed.forEach(f => f(7)); }, move(url) { tab.url = url; } };
}
const view = ids => ({ title: '無修正 - Supjav.com', html: page(ids) });

test('current tab loader reads the open page first, then navigates the same tab and stays on the last page', async () => {
  const t = fakeTab(pageUrl(2), { [pageUrl(2)]: view([8, 7]), [pageUrl(3)]: view([6, 5]), [pageUrl(4)]: view([4]) });
  const r = await collector().collect({ loader: currentTabLoader(t.api, 7), startPage: 2, maxPages: 3 });
  assert.equal(r.added, 5); assert.equal(r.lastPage, 4);
  assert.deepEqual(t.log.map(x => x[1].url), [pageUrl(3), pageUrl(4)]);
  assert.equal(t.tab.url, pageUrl(4));
});

test('current tab loader waits while the user passes a challenge in that tab', async () => {
  let solved = false, asked = 0;
  const t = fakeTab(LIST_URL, { [LIST_URL]: () => solved ? view([3, 2]) : { title: 'Just a moment...', html: challenge } });
  const loader = currentTabLoader(t.api, 7, { poll: 5, onChallenge: () => { asked++; setTimeout(() => { solved = true; }, 20); } });
  const r = await collector().collect({ loader, maxPages: 1 });
  assert.equal(asked, 1); assert.equal(r.added, 2);
  const stuck = fakeTab(LIST_URL, { [LIST_URL]: { title: 'Just a moment...', html: challenge } });
  assert.equal((await collector().collect({ loader: currentTabLoader(stuck.api, 7, { poll: 5, solveTimeout: 30 }) })).reason, 'challenge');
});

test('current tab loader stops if the user moves or closes the tab', async () => {
  const moved = fakeTab(LIST_URL, { [LIST_URL]: view([3]), [pageUrl(2)]: view([2]) });
  const c = new Collector(new CollectorDB(`test-${dbCount++}`), { parse, delay: async () => moved.move('https://supjav.com/ja/475015.html') });
  const r = await c.collect({ loader: currentTabLoader(moved.api, 7), maxPages: 3 });
  assert.equal(r.reason, 'tab-moved'); assert.equal(r.added, 1);
  const closed = fakeTab(LIST_URL, { [LIST_URL]: view([3]) });
  const c2 = new Collector(new CollectorDB(`test-${dbCount++}`), { parse, delay: async () => closed.close() });
  assert.equal((await c2.collect({ loader: currentTabLoader(closed.api, 7), maxPages: 3 })).reason, 'tab-closed');
});

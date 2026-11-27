export const STATUSES = { unread: '미확인', reviewing: '확인 중', done: '완료' };
export const PAGE_SIZE = 50;
export function check(condition, message) { if (!condition) throw new Error(message); }
export function restricted(url) { try { return !['http:', 'https:'].includes(new URL(url).protocol); } catch { return true; } }
export function domain(url) { try { return new URL(url).hostname || new URL(url).protocol; } catch { return '(잘못된 URL)'; } }
export function source(tab) {
  check(Number.isInteger(tab.id) && Number.isInteger(tab.windowId) && typeof tab.url === 'string' && tab.url.length > 0 && typeof tab.title === 'string', '탭 정보가 누락되었습니다. 아무 탭도 닫지 않습니다.');
  return { tabId: tab.id, windowId: tab.windowId, index: tab.index, url: tab.url, title: tab.title, pinned: !!tab.pinned, muted: !!tab.mutedInfo?.muted, cookieStoreId: tab.cookieStoreId || null, discarded: !!tab.discarded, hidden: !!tab.hidden };
}
export function sourceKey(session, s) { return JSON.stringify([session, s.tabId, s.url]); }
export function sameTab(s, t) { return t && !t.incognito && t.id === s.tabId && t.windowId === s.windowId && t.url === s.url && t.title === s.title && !!t.pinned === s.pinned && !!t.mutedInfo?.muted === s.muted && (t.cookieStoreId || null) === s.cookieStoreId && !t.pendingUrl && t.status !== 'loading'; }
export function newItem(s, now, id = crypto.randomUUID()) {
  return { id, url: s.url, title: s.title, status: 'unread', note: '', tags: [], createdAt: now, updatedAt: now, lastViewedAt: null, completedAt: null, deletedAt: null, warning: restricted(s.url), sources: [s] };
}
export const isSupjav = i => i.tags.includes('supjav') || i.url.startsWith('https://supjav.com/');
export function queryItems(items, options = {}) {
  const q = String(options.search || '').toLocaleLowerCase();
  const counts = { total: 0, unread: 0, reviewing: 0, done: 0, trash: 0 };
  for (const i of items) { if (i.recordOnly && options.source !== 'record') continue; if (i.deletedAt !== null) counts.trash++; else { counts.total++; counts[i.status]++; } }
  const filtered = items.filter(i => (options.trash ? i.deletedAt !== null : i.deletedAt === null) && (options.source !== 'supjav' || isSupjav(i)) && (options.source !== 'nocode' || !i.codeKey) && (options.source === 'record' || !i.recordOnly) && (!options.status || (options.status==='active' ? i.status!=='done' : i.status === options.status)) && (!q || `${i.title}\n${i.url}\n${i.note}\n${i.tags.join(' ')}\n${i.code || ''}`.toLocaleLowerCase().includes(q)));
  const compare = options.sort === 'domain' ? (a,b) => domain(a.url).localeCompare(domain(b.url), 'ko') : options.sort === 'title' ? (a,b) => a.title.localeCompare(b.title, 'ko') : options.sort === 'recent' ? (a,b) => (b.lastViewedAt || 0) - (a.lastViewedAt || 0) : options.sort === 'newest' ? (a,b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id) : (a,b) => a.createdAt - b.createdAt;
  filtered.sort((a,b) => compare(a,b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.max(1, Math.min(pages, Number(options.page) || 1));
  return { counts, total: filtered.length, page, pages, items: filtered.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE) };
}
export function validateBackup(data) {
  check(data && data.format === 'local-tab-vault' && [1,2,3].includes(data.version) && Array.isArray(data.items) && Array.isArray(data.jobs) && Array.isArray(data.checkpoints) && (data.settings === undefined || (Array.isArray(data.settings) && data.settings.every(s => s && typeof s.id === 'string'))), '지원하지 않는 백업 형식입니다.');
  check(data.items.length <= 100000, '한 번에 최대 100,000개 항목을 가져올 수 있습니다.');
  const ids = new Set();
  for (const i of data.items) {
    check(i && typeof i.id === 'string' && i.id.length > 0 && !ids.has(i.id), '항목 ID가 없거나 중복되었습니다.'); ids.add(i.id);
    check(typeof i.url === 'string' && i.url.length > 0 && i.url.length <= 100000 && typeof i.title === 'string' && i.title.length <= 100000, 'URL 또는 제목이 올바르지 않습니다.');
    check(Object.hasOwn(STATUSES, i.status) && typeof i.note === 'string' && i.note.length <= 100000 && Array.isArray(i.tags) && i.tags.length <= 100 && i.tags.every(t => typeof t === 'string' && t.length <= 200), '상태·메모·태그가 올바르지 않습니다.');
    check(Number.isFinite(i.createdAt) && Number.isFinite(i.updatedAt) && (i.deletedAt === null || Number.isFinite(i.deletedAt)) && (i.lastViewedAt === null || Number.isFinite(i.lastViewedAt)) && (i.completedAt === undefined || i.completedAt === null || Number.isFinite(i.completedAt)) && Array.isArray(i.sources), '항목 날짜 또는 원본 정보가 올바르지 않습니다.');
    for (const s of i.sources) check(s && typeof s.url === 'string' && typeof s.title === 'string' && Number.isInteger(s.tabId) && Number.isInteger(s.windowId) && Number.isInteger(s.index) && typeof s.pinned === 'boolean' && typeof s.muted === 'boolean' && (s.cookieStoreId === null || typeof s.cookieStoreId === 'string'), '원본 탭 정보가 올바르지 않습니다.');
  }
  return data;
}
export function escapeHTML(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
export function readableExport(items, html = false) {
  if (!html) return items.map(i => `[${i.deletedAt === null ? STATUSES[i.status] : '휴지통'}] ${i.title}\n${i.url}\n태그: ${i.tags.join(', ')}\n메모: ${i.note}`).join('\n\n');
  return '<!doctype html><html lang="ko"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'"><title>탭 보관함 URL 목록</title><h1>탭 보관함</h1><ol>' + items.map(i => `<li><h2>${escapeHTML(i.title)}</h2><p>${escapeHTML(i.deletedAt === null ? STATUSES[i.status] : '휴지통')}</p>${restricted(i.url) ? escapeHTML(i.url) : `<a rel="noreferrer noopener" href="${escapeHTML(i.url)}">${escapeHTML(i.url)}</a>`}<pre>${escapeHTML(i.tags.join(', ') + '\n' + i.note)}</pre></li>`).join('') + '</ol></html>';
}

import { applyCode } from './code.js';
export class VaultDB {
  constructor(name = 'local-tab-vault-v1') { this.name = name; }
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(this.name, 4);
      r.onupgradeneeded = event => {
        if(event.oldVersion < 1) for (const name of ['items','jobs','checkpoints']) r.result.createObjectStore(name, { keyPath: 'id' });
        if(event.oldVersion < 2) r.result.createObjectStore('settings', { keyPath: 'id' });
        if(event.oldVersion < 3) {
          r.transaction.objectStore('settings').put({id:'workflow',enabled:false,updatedAt:Date.now()});
          r.result.createObjectStore('workTabs',{keyPath:'id'});
          const cursor=r.transaction.objectStore('items').openCursor();
          cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;const item=c.value;if(item.status==='done' && item.completedAt==null)c.update({...item,completedAt:item.updatedAt});c.continue();};
        }
        if(event.oldVersion < 4) r.result.createObjectStore('outbox',{keyPath:'seq',autoIncrement:true}).createIndex('itemId','itemId');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error('보관함 저장소를 열지 못했습니다.'));
      r.onblocked = () => reject(new Error('다른 관리 화면을 닫고 다시 시도하세요.'));
    });
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this.db;
  }
  async snapshot() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const names=['items','jobs','checkpoints','settings','workTabs']; const tx = db.transaction(names, 'readonly');
      const result = {};
      for (const n of names) { const r = tx.objectStore(n).getAll(); r.onsuccess = () => { result[n] = r.result; }; }
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error('저장 내용을 읽지 못했습니다.'));
    });
  }
  // sync=true(서버 연동 중)이면 항목 변경을 같은 트랜잭션 안에서 outbox에 함께 기록한다.
  // opts.remote: 서버에서 받은 변경(다시 올리지 않음), opts.op='merge': 같은 URL이 서버에 있으면 서버가 건너뜀.
  async commit(changes, removals = {}, opts = {}) {
    for (const v of changes.items || []) applyCode(v); // 품번은 저장할 때마다 제목에서 계산
    const db = await this.open();
    const record = this.sync && !opts.remote;
    let queued = false;
    await new Promise((resolve, reject) => {
      const names=['items','jobs','checkpoints','settings','workTabs', ...(record ? ['outbox'] : [])]; const tx = db.transaction(names, 'readwrite', { durability: 'strict' });
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('저장 트랜잭션이 실패했습니다. 공간과 브라우저 설정을 확인하세요. 아무 탭도 닫지 않습니다.'));
      try {
        const outbox = record ? tx.objectStore('outbox') : null;
        if (outbox) {
          for (const id of removals.items || []) { outbox.add({ itemId: id, change: { op: 'delete', id } }); queued = true; }
          for (const value of changes.items || []) {
            const old = tx.objectStore('items').get(value.id);
            old.onsuccess = () => { const change = diffItem(old.result, value, opts.op); if (change) { outbox.add({ itemId: value.id, change }); queued = true; } };
          }
        }
        for (const n of names) {
          if (n === 'outbox') continue;
          for (const id of removals[n] || []) tx.objectStore(n).delete(id);
          for (const value of changes[n] || []) tx.objectStore(n).put(value);
        }
      } catch { tx.abort(); }
    });
    if (queued) this.onQueued?.();
  }
  async request(stores, mode, body) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode, { durability: 'strict' }); let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error('동기화 저장소 작업이 실패했습니다.'));
      try { body(tx, value => { result = value; }); } catch (e) { tx.abort(); }
    });
  }
  pending(limit = 200) {
    return this.request(['outbox'], 'readonly', (tx, done) => { const q = tx.objectStore('outbox').getAll(null, limit); q.onsuccess = () => done(q.result); });
  }
  // 값이 이미 같아도 서버로 올릴 patch를 대기열에 넣는다 (품번 칸을 서버에 처음 맞출 때)
  async queuePatches(list) {
    if (!list.length) return;
    await this.request(['outbox'], 'readwrite', tx => { for (const { id, fields } of list) tx.objectStore('outbox').add({ itemId: id, change: { op: 'patch', id, fields } }); });
    this.onQueued?.();
  }
  countPending() {
    return this.request(['outbox'], 'readonly', (tx, done) => { const q = tx.objectStore('outbox').count(); q.onsuccess = () => done(q.result); });
  }
  // 올린 변경 지우기 + 동기화 상태 저장을 한 번에
  ack(seqs, state) {
    return this.request(['outbox', 'settings'], 'readwrite', tx => { for (const seq of seqs) tx.objectStore('outbox').delete(seq); tx.objectStore('settings').put(state); });
  }
  clearPending() { return this.request(['outbox'], 'readwrite', tx => tx.objectStore('outbox').clear()); }
  // 서버 변경 반영. 아직 올리지 못한 변경이 있는 항목은 건너뛴다(올린 뒤 서버 결과가 다시 내려옴).
  // replace=true면 서버에 없는 항목을 캐시에서 지운다(전체 다시 받기).
  applyRemote(rows, state, { replace = false } = {}) {
    return this.request(['items', 'outbox', 'settings', 'checkpoints', 'workTabs'], 'readwrite', (tx, done) => {
      const items = tx.objectStore('items');
      let changed = 0; const removed = new Set();
      const keys = tx.objectStore('outbox').getAll();
      keys.onsuccess = () => {
        const pending = new Set(keys.result.map(e => e.itemId));
        const seen = new Set();
        for (const row of rows) {
          seen.add(row.id);
          if (pending.has(row.id)) continue;
          if (row.item) items.put(row.item); else { items.delete(row.id); removed.add(row.id); }
          changed++;
        }
        const finish = () => {
          if (removed.size) for (const store of ['checkpoints', 'workTabs']) { const all = tx.objectStore(store).getAll(); all.onsuccess = () => { for (const v of all.result) if (removed.has(v.itemId)) tx.objectStore(store).delete(v.id); }; }
          tx.objectStore('settings').put(state); done(changed);
        };
        if (!replace) return finish();
        const all = items.getAllKeys();
        all.onsuccess = () => { for (const id of all.result) if (!seen.has(id) && !pending.has(id)) { items.delete(id); removed.add(id); changed++; } finish(); };
      };
    });
  }
}

// 바뀐 칸만 patch로, 새 항목은 add(또는 merge)로 만든다. 바뀐 것이 없으면 null.
export function diffItem(old, next, op) {
  if (!old) return { op: op === 'merge' ? 'merge' : 'add', item: next };
  const fields = {};
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (key === 'id') continue;
    if (JSON.stringify(old[key]) !== JSON.stringify(next[key])) fields[key] = next[key] === undefined ? null : next[key];
  }
  return Object.keys(fields).length ? { op: 'patch', id: next.id, fields } : null;
}

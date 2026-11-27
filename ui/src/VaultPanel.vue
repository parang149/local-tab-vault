<script setup lang="ts">
// 보관함 화면 공용 부품. layout='sidebar'(사이드패널, 전부 세로로) / 'manager'(관리 화면, 위쪽 탭 5개로 나눔).
// 옛 sidebar.html·manager.html + manager.js와 같은 기능을 Nuxt UI로 다시 만든 것.
// 보관·닫기 안전 규칙은 백그라운드(service.js)에 있고, 화면은 같은 메시지만 보낸다.
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { changes, ext, rpc, type SyncInfo, type VaultItem } from './rpc'
// @ts-ignore 확장 쪽 공용 JS
import { describeRun, describeProgress } from '../../extension/supjav-text.js'
// @ts-ignore
import { readableExport, validateBackup, domain } from '../../extension/model.js'

const props = withDefaults(defineProps<{ layout?: 'sidebar' | 'manager' }>(), { layout: 'sidebar' })
const wide = props.layout === 'manager'
const SECTIONS = [{ label: '보관함', value: 'library', icon: 'i-lucide-library' }, { label: '열린 탭 보관', value: 'capture', icon: 'i-lucide-archive' }, { label: 'supjav', value: 'supjav', icon: 'i-lucide-image' }, { label: '백업', value: 'backup', icon: 'i-lucide-hard-drive-download' }, { label: '연동', value: 'sync', icon: 'i-lucide-refresh-cw' }]
const section = ref(localStorage.getItem('manager-section') || 'library')
watch(section, v => localStorage.setItem('manager-section', v))
const show = (s: string) => !wide || section.value === s
type ListResult = { items: (VaultItem & { warning?: boolean; sources: unknown[] })[]; page: number; pages: number; total: number; counts: Record<'total' | 'unread' | 'reviewing' | 'done' | 'trash', number> }
const toast = useToast()
const busy = ref(false)
const windowId = ref<number>()
const result = ref<ListResult | null>(null)
const page = ref(1)
const view = ref<'active' | 'reviewing' | 'done' | 'all' | 'trash'>('active')
const sort = ref('newest')
const source = ref('all')
const search = ref('')
const selecting = ref(false)
const selected = ref(new Set<string>())
const autoSync = ref(false)
const workMode = ref<'tab' | 'vault'>('tab')
const modePick = ref(false)
const sync = ref<SyncInfo | null>(null)

function say(title: string, error = false) { toast.add({ title, color: error ? 'error' : 'primary', icon: error ? 'i-lucide-circle-alert' : 'i-lucide-circle-check' }) }
let pendingRefresh = false
async function task(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  try { await fn() } catch (e) { say(e instanceof Error ? e.message : String(e), true) }
  finally { busy.value = false; if (pendingRefresh) { pendingRefresh = false; void task(reload) } }
}
function refreshSoon() { if (busy.value) pendingRefresh = true; else void task(reload) }

async function reload() {
  const r = await rpc<ListResult>('list', { page: page.value, search: search.value, status: view.value === 'all' || view.value === 'trash' ? '' : view.value, sort: sort.value, source: source.value, trash: view.value === 'trash' })
  result.value = r; page.value = r.page; selected.value = new Set()
}
const remaining = computed(() => result.value ? result.value.counts.unread + result.value.counts.reviewing : null)
const tabs = computed(() => {
  const c = result.value?.counts
  return [
    { label: '미완료', value: 'active' }, { label: `확인 중${c?.reviewing ? ` ${c.reviewing}` : ''}`, value: 'reviewing' }, { label: `완료${c ? ` ${c.done}` : ''}`, value: 'done' },
    { label: '전체', value: 'all' }, { label: `휴지통${c?.trash ? ` ${c.trash}` : ''}`, value: 'trash' },
  ]
})
const SORTS = [{ label: '최신순', value: 'newest' }, { label: '저장 순서', value: 'order' }, { label: '도메인', value: 'domain' }, { label: '제목', value: 'title' }, { label: '최근 확인', value: 'recent' }]
const STATUS = { unread: '미확인', reviewing: '확인 중', done: '완료' } as Record<string, string>
watch([view, sort, source], () => { page.value = 1; selecting.value = false; void task(reload) })
// 작업 시작은 지금 보는 정렬 방향을 따른다(최신순이면 화면 아래 = 더 오래된 항목으로 진행)
watch(sort, value => void rpc('setWorkOrder', { order: value === 'newest' ? 'newest' : 'oldest' }).catch(() => {}), { immediate: true })
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page.value = 1; void task(reload) }, 180) })
function goPage(n: number) { page.value = n; void task(reload) }

// ── 확인창(브라우저 confirm/prompt 대신) ──
const ask = reactive({ open: false, title: '', description: '', confirm: '확인', color: 'primary' as 'primary' | 'error', typed: '', input: '', resolve: (_: string | null) => {} })
function confirmBox(o: { title: string; description?: string; confirm?: string; danger?: boolean; typed?: string }) {
  return new Promise<string | null>(resolve => Object.assign(ask, { open: true, title: o.title, description: o.description || '', confirm: o.confirm || '확인', color: o.danger ? 'error' : 'primary', typed: o.typed || '', input: '', resolve }))
}
function closeAsk(ok: boolean) { const r = ask.resolve; ask.open = false; r(ok ? (ask.typed ? ask.input : 'yes') : null) }
watch(() => ask.open, open => { if (!open) ask.resolve(null) })

// ── 항목 ──
async function itemAction(action: string, item: VaultItem) {
  if (action === 'edit') { Object.assign(edit, { open: true, item, note: item.note, tags: item.tags.join(', ') }); return }
  await task(async () => {
    if (action === 'open' || action === 'background') { await rpc('openOne', { id: item.id, active: action === 'open', windowId: windowId.value }); say('항목 하나를 열었습니다. 보관 항목은 유지됩니다.') }
    else if (action.startsWith('status:')) { await rpc('mutate', { ids: [item.id], action: 'status', status: action.split(':')[1] }); say('상태를 저장했습니다.') }
    else { await rpc('mutate', { ids: [item.id], action }); say(action === 'delete' ? '휴지통으로 이동했습니다.' : '복원했습니다.') }
    await reload()
  })
}
type Row = ListResult['items'][number]
const info = reactive<{ open: boolean; item: Row | null }>({ open: false, item: null })
const codeInput = ref('')
const showDetail = (item: Row) => { codeInput.value = (item as any).codeManual || ''; Object.assign(info, { open: true, item }) }
// 품번 직접 입력: 비우면 제목에서 자동 계산 (code.js 규칙)
const saveCode = () => { const i = info.item; if (!i) return; void rpc('mutate', { ids: [i.id], action: 'code', note: codeInput.value }).then(() => { say(codeInput.value.trim() ? '품번을 직접 지정했습니다.' : '품번을 자동 계산으로 되돌렸습니다.'); info.open = false; refreshSoon() }, e => say(e.message, true)) }
const when = (t: number | null | undefined) => t ? new Date(t).toLocaleString('ko-KR', { hour12: false }) : ''
// nyaa 기록 요약(서버가 계산): 열람·검색·다운로드 횟수와 마지막 시각, 저장 경로
const isoWhen = (t?: string | null) => t ? new Date(t).toLocaleString('ko-KR', { hour12: false }) : ''
function nyaaRows(n: any): string[][] {
  if (!n) return []
  const row = (label: string, s: any) => s?.count ? [label, `${s.count}회 · 마지막 ${isoWhen(s.last)}`] : [label, '']
  const d = n.downloaded
  return [row('nyaa 열람', n.viewed), row('nyaa 검색', n.searched), row('nyaa 다운로드', d), ['저장 경로', d?.savepath || '']]
}
const detailRows = computed(() => {
  const i = info.item
  if (!i) return []
  return [['상태', i.deletedAt !== null ? '휴지통' : STATUS[i.status]], ['수집 날짜', when(i.createdAt)], ['포스트 날짜', i.supjav?.date || ''],
    ['완료 날짜', when(i.completedAt)], ['마지막 확인', when(i.lastViewedAt)], ['휴지통 이동', when(i.deletedAt)], ['태그', i.tags.join(', ')], ['메모', i.note],
    ['다른 주소', ((i as any).urls || []).filter((u: string) => u !== i.url).join(', ')], ...nyaaRows((i as any).nyaa)].filter(r => r[1])
})
const gridView = ref(wide && localStorage.getItem('manager-layout') === 'grid')
watch(gridView, v => localStorage.setItem('manager-layout', v ? 'grid' : 'list'))
function menu(item: Row) {
  const info = [{ label: '상세 보기', icon: 'i-lucide-info', onSelect: () => showDetail(item) }]
  if (item.deletedAt !== null) return [info, [{ label: '휴지통에서 복원', icon: 'i-lucide-rotate-ccw', onSelect: () => itemAction('restore', item) }]]
  return [info,
    [{ label: '하나 열기', icon: 'i-lucide-external-link', disabled: item.warning, onSelect: () => itemAction('open', item) },
     { label: '백그라운드로 열기', icon: 'i-lucide-square-arrow-out-up-right', disabled: item.warning, onSelect: () => itemAction('background', item) }],
    [{ label: '완료', icon: 'i-lucide-check', disabled: item.status === 'done', onSelect: () => itemAction('status:done', item) },
     { label: '미확인으로', icon: 'i-lucide-circle', disabled: item.status === 'unread', onSelect: () => itemAction('status:unread', item) },
     { label: '메모 / 태그', icon: 'i-lucide-pencil', onSelect: () => itemAction('edit', item) }],
    [{ label: '휴지통으로', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => itemAction('delete', item) }],
  ]
}
function middleClick(event: MouseEvent, item: ListResult['items'][number]) { if (event.button === 1 && !item.warning && item.deletedAt === null) { event.preventDefault(); void itemAction('background', item) } }
function toggle(id: string) { const s = new Set(selected.value); s.has(id) ? s.delete(id) : s.add(id); selected.value = s }
const allOnPage = computed({
  get: () => !!result.value?.items.length && result.value.items.every(i => selected.value.has(i.id)),
  set: on => { selected.value = on ? new Set(result.value?.items.map(i => i.id)) : new Set() },
})
async function bulk(kind: 'unread' | 'done' | 'delete' | 'restore') {
  const count = selected.value.size
  const label = { unread: '미확인으로 변경', done: '완료 처리', delete: '휴지통으로 이동', restore: '복원' }[kind]
  if (!await confirmBox({ title: `선택한 ${count}개 항목을 ${label}할까요?`, confirm: label, danger: kind === 'delete' })) return
  await task(async () => {
    await rpc('mutate', { ids: [...selected.value], action: kind === 'unread' || kind === 'done' ? 'status' : kind, status: kind === 'unread' ? 'unread' : 'done' })
    await reload(); selecting.value = false; say(`${count}개 항목을 처리했습니다.`)
  })
}
async function emptyTrash() {
  await task(async () => {
    const { ids } = await rpc<{ ids: string[] }>('prepareEmptyTrash')
    if (!ids.length) { await reload(); say('휴지통이 비어 있습니다.'); return }
    busy.value = false
    const ok = await confirmBox({ title: `휴지통 전체 ${ids.length}개를 영구 삭제할까요?`, description: '검색·페이지·선택과 관계없이 모두 삭제되며 복구할 수 없습니다.', confirm: '영구 삭제', danger: true })
    busy.value = true
    if (!ok) { say('휴지통 비우기를 취소했습니다.'); return }
    const r = await rpc<{ removed: number }>('emptyTrash', { ids, confirmed: true })
    await reload(); say(`휴지통 ${r.removed}개를 영구 삭제했습니다.`)
  })
}

// ── 메모·태그 ──
const edit = reactive({ open: false, item: null as VaultItem | null, note: '', tags: '' })
function saveEdit() {
  void task(async () => {
    await rpc('mutate', { ids: [edit.item!.id], action: 'edit', note: edit.note, tags: edit.tags.split(',').map(t => t.trim()).filter(Boolean) })
    edit.open = false; await reload(); say('메모와 태그를 저장했습니다.')
  })
}

// ── 열린 탭 보관: 로컬 저장·검증 → (확인창) → 검증된 탭 닫기. 서버에는 뒤에서 바로 올라간다 ──
const scope = ref('current')
const captureConfirm = ref(localStorage.getItem('capture-confirm') !== '0') // PC별, 기본 켜짐
watch(captureConfirm, v => localStorage.setItem('capture-confirm', v ? '1' : '0'))
const vaultBusy = ref<null | 'collect' | 'capture'>(null)
const syncLogs = ref<any[]>([])
const loadSyncLog = async () => { syncLogs.value = await rpc<any[]>('syncLog').catch(() => []) }
const capturing = ref(false)
function capture() {
  if (capturing.value) return
  capturing.value = true
  void (async () => {
    let saved: { id: string; captured: number; created: number; loading: number } | null = null
    try {
      saved = await rpc('captureStart', { scope: scope.value, windowId: windowId.value, dedupe: true })
      await reload()
      const s = saved!
      const head = `${s.captured}개 저장·검증 완료${s.loading ? ` · 로딩 중 ${s.loading}개 제외` : ''}`
      if (captureConfirm.value) {
        const ok = await confirmBox({ title: `탭 ${s.captured}개를 닫을까요?`, description: `${head}. 저장 뒤 바뀐 탭은 열어 둡니다.`, confirm: '탭 닫기', danger: true })
        if (ok === null) { await rpc('captureCancel'); say(`${head} · 탭은 닫지 않았습니다.`); return }
      }
      const r = await rpc<{ closed: number; kept: number }>('captureClose', { jobId: s.id })
      say(`${head} · ${r.closed}개 닫음${r.kept ? ` · ${r.kept}개 열어 둠` : ''}`)
    } catch (e) {
      if (saved) await rpc('captureCancel').catch(() => {})
      say(e instanceof Error ? e.message : String(e), true)
    } finally { capturing.value = false; refreshSoon() }
  })()
}
// 정리: 이미 보관함에 있는 탭만 확인 후 닫기(관리 화면)
function tidy() {
  if (capturing.value) return
  capturing.value = true
  void (async () => {
    let plan: { id: string; count: number; loading: number } | null = null
    try {
      plan = await rpc('tidyStart', { scope: scope.value, windowId: windowId.value })
      const p = plan!
      const extra = p.loading ? ` · 로딩 중 ${p.loading}개 제외` : ''
      if (!p.count) { await rpc('captureCancel'); say(`보관함에 이미 있는 열린 탭이 없습니다${extra}.`); return }
      if (captureConfirm.value) {
        const ok = await confirmBox({ title: `보관함에 이미 있는 탭 ${p.count}개를 닫을까요?`, description: `새로 저장하지 않고, 보관함에 있는지 다시 확인한 뒤 닫습니다${extra}.`, confirm: '탭 닫기', danger: true })
        if (ok === null) { await rpc('captureCancel'); say('정리를 취소했습니다.'); return }
      }
      const r = await rpc<{ closed: number; kept: number }>('tidyClose', { id: p.id })
      say(`정리: ${r.closed}개 닫음${r.kept ? ` · ${r.kept}개 열어 둠` : ''}${extra}`)
    } catch (e) {
      if (plan) await rpc('captureCancel').catch(() => {})
      say(e instanceof Error ? e.message : String(e), true)
    } finally { capturing.value = false; refreshSoon() }
  })()
}
function download(data: string, extension: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: `tab-vault-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}` })
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000)
}
const exportJSON = () => task(async () => { const data = await rpc('exportJSON'); download(JSON.stringify(data, null, 2), 'json', 'application/json'); say(`전체 ${data.items.length}개 항목을 JSON으로 내보냈습니다. 다운로드가 끝났는지 확인하세요.`) })
const exportText = (html: boolean) => task(async () => { const data = await rpc('exportJSON'); download(readableExport(data.items, html), html ? 'html' : 'txt', html ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8'); say('전체 URL 목록을 내보냈습니다.') })
async function readFile(input: HTMLInputElement) {
  const file = input.files?.[0]; if (!file) return null
  if (file.size > 100 * 1024 * 1024) throw new Error('100MB 이하 JSON 파일만 지원합니다.')
  const data = JSON.parse(await file.text()); validateBackup(data); return data
}
const importInput = ref<HTMLInputElement | null>(null)
function importFile() {
  void task(async () => {
    try {
      const data = await readFile(importInput.value!); if (!data) return
      busy.value = false
      const ok = await confirmBox({ title: `${data.items.length}개 항목의 JSON을 가져올까요?`, description: '기존 ID는 건너뛰며 기존 항목을 덮어쓰지 않습니다.', confirm: '가져오기' })
      busy.value = true
      if (!ok) return
      const r = await rpc<{ added: number; skipped: number }>('importJSON', { data }); await reload()
      say(`${r.added}개 추가, 기존 ID ${r.skipped}개 건너뜀.`)
    } finally { importInput.value!.value = '' }
  })
}
async function containerPermission() {
  try { say(await ext.permissions.request({ permissions: ['cookies'] }) ? '원래 컨테이너 열기 권한이 허용되었습니다.' : '권한을 허용하지 않았습니다.') }
  catch { say('권한 요청을 완료하지 못했습니다.', true) }
}

// ── 작업 시작 ──
// 켤 때는 작업 종류를 고른다: 탭 작업(지금 그대로) / 보관함 작업(정렬 순서대로 열고 nyaa 다운로드·탭 닫기 단축키로 완료)
function setAutoSync(on: boolean, mode?: 'tab' | 'vault') {
  if (on && !mode) { modePick.value = true; return }
  modePick.value = false
  void task(async () => {
    const state = await rpc<{ enabled: boolean; mode: 'tab' | 'vault' }>('setAutoSync', { enabled: on, mode }); autoSync.value = state.enabled; workMode.value = state.mode
    say(!state.enabled ? '작업 중지. 탭 닫힘에 반응하지 않습니다.' : state.mode === 'vault' ? '보관함 작업 시작. 슬롯 단축키로 받거나 탭 닫기 단축키로 닫으면 완료, 그냥 닫으면 미완료로 두고 다음 항목을 엽니다.' : '탭 작업 시작. 하나를 닫으면 같은 URL 탭도 함께 닫고 완료 후 다음 항목 하나를 엽니다.')
  })
}

// ── supjav 수집 ──
const KEY = 'supjav-collect'
const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} } })()
const settingsOpen = ref(localStorage.getItem('supjav-settings-open') === '1')
watch(settingsOpen, v => localStorage.setItem('supjav-settings-open', v ? '1' : '0'))
const collect = reactive({ mode: saved.mode === 'date' ? 'date' : 'new', maxPages: Number(saved.maxPages) || 5, untilDate: saved.untilDate || '', running: false, status: 'supjav 일본어 목록 탭을 열고 수집을 누르세요.', error: false })
watch(() => [collect.mode, collect.maxPages, collect.untilDate], () => localStorage.setItem(KEY, JSON.stringify({ mode: collect.mode, maxPages: collect.maxPages, untilDate: collect.untilDate })))
async function startCollect() {
  if (collect.mode === 'date' && !collect.untilDate) { Object.assign(collect, { status: '날짜까지 수집하려면 날짜를 정해 주세요.', error: true }); return }
  try {
    const r = await rpc<{ startPage: number }>('supjavStart', { windowId: windowId.value, mode: collect.mode, maxPages: Math.max(1, Math.min(100, collect.maxPages || 5)), untilDate: collect.untilDate })
    Object.assign(collect, { running: true, status: `${r.startPage}쪽부터 수집을 시작합니다.`, error: false })
  } catch (e) { Object.assign(collect, { status: e instanceof Error ? e.message : String(e), error: true }) }
}
function stopCollect() { void rpc('supjavStop').then(() => Object.assign(collect, { status: '지금 쪽을 마치고 멈춥니다…', error: false })).catch(() => {}) }
const openManager = () => void task(() => rpc('openManager', { windowId: windowId.value }))
const SYNC: Record<string, { label: string; color: string }> = {
  connected: { label: '서버 연결됨', color: 'success' }, connecting: { label: '연결 중', color: 'warning' },
  offline: { label: '서버 연결 안 됨', color: 'error' }, unauthorized: { label: '주소 오류', color: 'error' }, off: { label: '로컬 모드', color: 'neutral' },
}

// ── 서버 연동 설정(관리 화면 연동 탭) ──
const server = reactive({ url: '', name: '' })
// nyaa 설정 창과 같은 모양: 서버 + 토큰 끝 3자리
const vaultLabel = (url: string) => { const m = /^(.*)\/api\/vault\/([0-9a-f]{64})\/?$/i.exec(url.trim()); return m ? `${m[1]} · 토큰 …${m[2].slice(-3).toLowerCase()}` : '주소 모양이 올바르지 않음' }
const SYNC_TEXT: Record<string, string> = { off: '로컬 모드 · 이 PC 보관함만 사용(바뀐 내용은 연동을 켜면 먼저 서버에 올라감)', connecting: '연결 중…', connected: '연결됨 · 실시간 동기화 중', offline: '서버에 연결되지 않음 · 다시 연결 중', unauthorized: '주소(토큰)가 맞지 않아 멈춤' }
const syncText = computed(() => { const i: any = sync.value; if (!i) return '확인 중…'; return `${i.status === 'off' ? '' : '서버 모드 · '}${SYNC_TEXT[i.status] || i.status}${i.enabled && i.address ? ` · ${i.address}` : ''}${i.name ? ` · ${i.name}` : ''}${i.pending ? ` · 서버 미반영 ${i.pending}개` : ''}${i.lastSync ? ` · 마지막 동기화 ${new Date(i.lastSync).toLocaleTimeString('ko-KR')}` : ''}${i.error && i.status !== 'connected' ? ` · ${i.error}` : ''}` })
async function connectServer() {
  const url = server.url.trim(); const m = /^(https?:\/\/[^/?#]+)\/api\/vault\/[0-9a-f]{64}\/?$/i.exec(url)
  if (!m) { say('hitomi-web 설정 › API의 "확장에 넣을 주소"를 그대로 붙여 넣으세요.', true); return }
  try {
    // Firefox 권한 패턴에는 포트를 넣을 수 없어 호스트만 요청한다(사용자 클릭 직후 호출해야 함).
    const host = new URL(m[1])
    if (!await ext.permissions.request({ origins: [`${host.protocol}//${host.hostname}/*`] })) { say('서버 주소 접근 권한이 필요합니다.', true); return }
    sync.value = await rpc('syncConfigure', { url, name: server.name.trim() }); server.url = ''
    say('연동을 켰습니다. 처음 연결이면 이 PC 항목을 서버로 올린 뒤 서버 목록으로 맞춥니다.')
  } catch (e) { say(e instanceof Error ? e.message : String(e), true) }
}
const resyncServer = () => void rpc('syncResync').then(i => { sync.value = i; say('서버 기준으로 다시 받습니다.') }, e => say(e.message, true))
const disableServer = () => void rpc('syncDisable').then(i => { sync.value = i; say('연동을 껐습니다. 이 PC 단독 보관함으로 동작합니다.') }, e => say(e.message, true))
watch(sync, i => { if ((i as any)?.name && !server.name) server.name = (i as any).name })

// ── FC@nyaa 연동(같은 PC의 nyaa.exe) ──
type FcInfo = { enabled: boolean; url: string; status: 'off' | 'connecting' | 'connected' | 'offline'; error: string; version: string; log: { at: number; text: string; ok: boolean }[] }
const fc = ref<FcInfo | null>(null)
const fcUrl = ref('')
const FC_TEXT: Record<string, string> = { off: '꺼짐', connecting: '연결 중…', connected: '연결됨', offline: 'nyaa.exe에 연결되지 않음 · 다시 연결 중' }
const fcText = computed(() => { const i = fc.value; if (!i) return '확인 중…'; return `${FC_TEXT[i.status] || i.status}${i.status === 'connected' && i.version ? ` · nyaa v${i.version}` : ''} · ${i.url}` })
const fcMedia = ref(false)
async function loadFc() {
  fc.value = await rpc<FcInfo>('fcInfo').catch(() => null)
  if (fc.value && !fcUrl.value) fcUrl.value = fc.value.url
  try { fcMedia.value = !!await ext.permissions.contains({ origins: ['*://*/*'] }) } catch { fcMedia.value = false }
}
const configureFc = (enabled: boolean) => void rpc<FcInfo>('fcConfigure', { enabled, url: fcUrl.value.trim() }).then(i => { fc.value = i; say(enabled ? 'FC@nyaa 연동을 켰습니다.' : 'FC@nyaa 연동을 껐습니다.') }, e => say(e.message, true))
async function allowFcMedia() {
  // 사용자 클릭 직후 호출해야 한다. supjav 플레이어 iframe(다른 도메인)의 영상을 제어하려면 필요.
  try { fcMedia.value = !!await ext.permissions.request({ origins: ['*://*/*'] }); say(fcMedia.value ? '영상 제어 권한을 허용했습니다.' : '권한을 허용하지 않았습니다. 영상 재생/정지가 플레이어 안에서는 동작하지 않을 수 있습니다.', !fcMedia.value) }
  catch (e) { say(e instanceof Error ? e.message : String(e), true) }
}

function onMessage(m: any) {
  if (m?.type === 'local-tab-vault-sync') { autoSync.value = m.enabled; if (m.finished) say('보관함 작업 끝. 남은 미완료 항목이 없습니다.') }
  if (m?.type === 'local-tab-vault-live') refreshSoon()
  if (m?.type === 'local-tab-vault-updated') { say(m.closeFailed ? '중복 탭 닫기 실패 또는 탭 변경: 완료 및 다음 항목 열기를 중단했습니다.' : `작업 처리: ${m.changed}개 항목 완료${m.opened ? ' · 다음 항목을 열었습니다.' : m.nextFailed ? ' · 다음 항목 자동 열기에 실패했습니다.' : ''}`, !!m.closeFailed); refreshSoon() }
  if (m?.type === 'vault-sync-status') sync.value = m
  if (m?.type === 'fc-status') { const { type: _t, ...rest } = m; fc.value = rest }
  if (m?.type === 'vault-busy') vaultBusy.value = m.busy
  if (m?.type === 'supjav-progress') Object.assign(collect, { running: true, status: describeProgress(m), error: false })
  if (m?.type === 'supjav-challenge') Object.assign(collect, { status: '수집 탭에 Cloudflare 확인 화면이 떴습니다. 그 탭에서 직접 통과하면 이어서 수집합니다(최대 3분).', error: false })
  if (m?.type === 'supjav-done') Object.assign(collect, { running: false, status: m.error ? m.error : '수집 완료: ' + describeRun(m.result), error: !!m.error || !['caught-up', 'date-reached', 'limit', 'stopped', 'end'].includes(m.result?.reason) })
}
const onChannel = (event: MessageEvent) => { if (event.data !== 'theme') refreshSoon() }
onMounted(() => {
  ext.runtime.onMessage.addListener(onMessage); changes?.addEventListener('message', onChannel)
  void rpc<{ busy: null | 'collect' | 'capture' }>('busyState').then(r => { vaultBusy.value = r.busy }).catch(() => {})
  void task(async () => {
    windowId.value = (await ext.windows.getCurrent()).id
    { const st = await rpc<{ enabled: boolean; mode: 'tab' | 'vault' }>('autoSyncState'); autoSync.value = st.enabled; workMode.value = st.mode }
    sync.value = await rpc<SyncInfo>('syncInfo').catch(() => null)
    void loadFc().catch(() => {})
    const last = await rpc<{ last: unknown; running: boolean }>('supjavList').catch(() => null)
    if (last) { collect.running = last.running; if (last.last) collect.status = '마지막 수집: ' + describeRun(last.last) }
    await reload()
  })
})
onBeforeUnmount(() => { ext.runtime.onMessage.removeListener(onMessage); changes?.removeEventListener('message', onChannel) })
</script>

<template>
  <UApp :toaster="{ position: 'bottom-center', duration: 4000 }">
    <div class="flex min-h-screen flex-col" :class="wide ? 'mx-auto max-w-5xl gap-4 p-6' : 'gap-3 p-3 text-sm'">
      <header class="flex items-center justify-between gap-2">
        <h1 v-if="wide" class="text-2xl font-bold">탭 보관함 <span class="ml-2 text-base font-normal text-muted">미완료 {{ remaining === null ? '—' : remaining.toLocaleString() }}개</span></h1>
        <h1 v-else class="text-lg font-bold">미완료 {{ remaining === null ? '—' : remaining.toLocaleString() }}개</h1>
        <div class="ml-auto flex items-center gap-1.5">
          <UBadge v-if="sync" :color="(SYNC[sync.status]?.color as any) || 'neutral'" variant="soft" class="shrink-0">{{ SYNC[sync.status]?.label }}<template v-if="sync.pending"> · {{ sync.pending }}</template></UBadge>
        </div>
        <div v-if="!wide" class="flex gap-1.5">
          <UButton size="md" color="neutral" variant="soft" icon="i-lucide-maximize-2" aria-label="전체 화면" title="넓은 관리 화면을 탭으로 열기" @click="openManager" />
        </div>
      </header>

      <div class="flex items-center justify-between gap-2 rounded-lg bg-elevated px-3 py-2">
        <USwitch :model-value="autoSync" :disabled="busy" :label="autoSync ? (workMode === 'vault' ? '보관함 작업 중' : '탭 작업 중') : '작업 시작'" :description="!wide ? undefined : !autoSync ? '꺼짐 · 탭 닫힘에 반응하지 않음' : workMode === 'vault' ? '받거나 탭 닫기 단축키 → 완료, 그냥 닫기 → 미완료 · 다음 항목 열기' : '켜짐 · 중복 탭 함께 닫고 다음 항목 열기'" @update:model-value="(v: boolean) => setAutoSync(v)" />
        <UModal v-model:open="modePick" title="작업 시작" description="어떤 작업을 할까요?">
          <template #body>
            <div class="flex flex-col gap-2">
              <UButton block size="lg" variant="soft" icon="i-lucide-panels-top-left" @click="setAutoSync(true, 'tab')">탭 작업 · 지금 열린 탭 기준</UButton>
              <UButton block size="lg" icon="i-lucide-archive" @click="setAutoSync(true, 'vault')">보관함 작업 · 정렬 순서대로 하나씩 열기</UButton>
            </div>
          </template>
        </UModal>
      </div>

      <UTabs v-if="wide" v-model="section" :items="SECTIONS" :content="false" class="w-full" />

      <section v-if="show('supjav')" class="rounded-lg border border-default p-3" aria-label="supjav 수집">
        <p v-if="wide" class="mb-3 text-sm text-muted">supjav 일본어 목록(https://supjav.com/ja/category/uncensored-jav)을 연 탭에서 사이드패널의 수집을 누르면 그 탭이 쪽을 넘기며 수집합니다. 범위는 여기서도 바꿀 수 있습니다.</p>
        <div class="flex items-center gap-1.5">
          <strong class="mr-auto">supjav 수집</strong>
          <UButton v-if="collect.running" size="md" color="error" icon="i-lucide-circle-stop" title="지금 쪽을 마치고 멈춤" @click="stopCollect">중지</UButton>
          <UButton v-else size="md" icon="i-lucide-download" :disabled="vaultBusy === 'capture'" :title="vaultBusy === 'capture' ? '탭 정리 중에는 쓸 수 없습니다' : '지금 보고 있는 supjav 일본어 목록 탭에서 수집 시작'" @click="startCollect">수집</UButton>
          <UButton v-if="!wide" size="md" color="neutral" variant="ghost" :icon="settingsOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" :aria-label="settingsOpen ? '설정 접기' : '설정 펴기'" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen" />
        </div>
        <div v-show="wide || settingsOpen" class="mt-2 flex flex-wrap items-center gap-2">
          <USelect v-model="collect.mode" size="md" :items="[{ label: '새 글만', value: 'new' }, { label: '날짜까지', value: 'date' }]" class="w-28" aria-label="수집 범위" />
          <span v-if="collect.mode === 'new'" class="flex items-center gap-1.5 whitespace-nowrap">최대 <UInputNumber v-model="collect.maxPages" size="md" :min="1" :max="100" class="w-24" aria-label="최대 쪽 수" />쪽</span>
          <UInput v-else v-model="collect.untilDate" size="md" type="date" aria-label="이 날짜까지 수집" />
        </div>
        <p v-show="wide || settingsOpen || collect.running" class="mt-2 text-xs" :class="collect.error ? 'text-error' : 'text-muted'" aria-live="polite">{{ collect.status }}</p>
      </section>

      <p v-if="wide && show('capture')" class="text-sm text-muted">현재 창 또는 모든 일반 창의 열린 탭을 보관함(이 PC)에 저장하고, 저장된 것을 다시 읽어 검증한 뒤 탭을 닫습니다. 서버에는 바로 올라가고, 연결이 끊겨 있으면 연결된 뒤 올라갑니다. 같은 주소는 합칩니다. about: 같은 브라우저 내부 탭, supjav 목록 페이지, 로딩 중인 탭은 저장하지 않습니다.</p>
      <div v-if="show('capture')" class="flex gap-1.5">
        <USelect v-model="scope" size="md" :items="[{ label: '현재 창', value: 'current' }, { label: '모든 일반 창', value: 'all' }]" class="w-32" aria-label="저장 범위" />
        <UButton size="md" icon="i-lucide-archive" class="flex-1 justify-center" :loading="capturing" :disabled="busy || capturing || vaultBusy === 'collect'"
          :title="vaultBusy === 'collect' ? 'supjav 수집 중에는 쓸 수 없습니다' : '저장·검증 후 탭을 닫습니다'" @click="capture">열린 탭 보관</UButton>
        <UButton v-if="wide" size="md" color="neutral" variant="soft" icon="i-lucide-list-checks" :disabled="busy || capturing || vaultBusy === 'collect'"
          title="이미 보관함에 있는 탭만 확인 후 닫습니다(새로 저장하지 않음)" @click="tidy">정리</UButton>
      </div>
      <USwitch v-if="wide && show('capture')" v-model="captureConfirm" label="탭 닫기 전 확인창 띄우기" description="이 PC에만 적용됩니다." />

      <template v-if="show('library')">
      <div v-if="wide && result" class="grid grid-cols-5 gap-2">
        <div v-for="[key, label] in [['total', '보관함 전체'], ['unread', '미확인'], ['reviewing', '확인 중'], ['done', '완료'], ['trash', '휴지통']]" :key="key" class="rounded-lg bg-elevated px-3 py-2">
          <strong class="block text-lg">{{ result.counts[key as keyof ListResult['counts']].toLocaleString() }}</strong><span class="text-xs text-muted">{{ label }}</span>
        </div>
      </div>
      <UTabs v-model="view" :items="tabs" :content="false" size="md" class="w-full" />
      <div class="flex gap-1.5">
        <UInput v-model="search" size="md" icon="i-lucide-search" placeholder="제목, URL, 메모 검색" class="min-w-0 flex-1" :maxlength="500" />
        <USelect v-model="source" size="md" :items="[{ label: '전체', value: 'all' }, { label: 'supjav', value: 'supjav' }, { label: '품번 없음', value: 'nocode' }, { label: 'nyaa 기록만', value: 'record' }]" class="w-32" aria-label="출처" />
        <USelect v-model="sort" size="md" :items="SORTS" class="w-28" aria-label="정렬" />
        <UButton size="md" color="neutral" variant="soft" icon="i-lucide-refresh-cw" aria-label="새로고침" :disabled="busy" @click="task(reload)" />
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <UButton size="sm" color="neutral" :variant="selecting ? 'solid' : 'soft'" icon="i-lucide-list-checks" @click="selecting = !selecting; selected = new Set()">{{ selecting ? `${selected.size}개 선택` : '선택' }}</UButton>
        <template v-if="selecting">
          <UCheckbox v-model="allOnPage" label="이 쪽 전체" />
          <template v-if="view !== 'trash'">
            <UButton size="sm" variant="soft" :disabled="busy || !selected.size" @click="bulk('done')">완료</UButton>
            <UButton size="sm" color="neutral" variant="soft" :disabled="busy || !selected.size" @click="bulk('unread')">미확인</UButton>
            <UButton size="sm" color="error" variant="soft" :disabled="busy || !selected.size" @click="bulk('delete')">휴지통</UButton>
          </template>
          <UButton v-else size="sm" variant="soft" :disabled="busy || !selected.size" @click="bulk('restore')">복원</UButton>
        </template>
        <UFieldGroup v-if="wide" role="group" aria-label="보기 방식" :class="view === 'trash' ? '' : 'ml-auto'">
          <UButton v-for="v in ([{ grid: false, icon: 'i-lucide-list', label: '목록 보기' }, { grid: true, icon: 'i-lucide-layout-grid', label: '그리드 보기' }] as const)" :key="v.label" size="sm" square
            :icon="v.icon" :aria-label="v.label" :title="v.label" :aria-pressed="gridView === v.grid" :color="gridView === v.grid ? 'primary' : 'neutral'" :variant="gridView === v.grid ? 'solid' : 'outline'" @click="gridView = v.grid" />
        </UFieldGroup>
        <UButton v-if="view === 'trash'" size="sm" color="error" variant="ghost" icon="i-lucide-trash-2" class="ml-auto" :disabled="busy || !result?.counts.trash" @click="emptyTrash">휴지통 비우기</UButton>
      </div>

      <div v-if="gridView" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label="저장 항목">
        <p v-if="result && !result.items.length" class="col-span-full py-8 text-center text-muted">표시할 항목이 없습니다.</p>
        <div v-for="item in result?.items" :key="item.id" class="relative flex flex-col overflow-hidden rounded-lg border border-default bg-elevated/40" :class="{ 'opacity-60': item.status === 'done' || item.deletedAt !== null }">
          <button type="button" class="text-left disabled:cursor-default" :disabled="busy || item.warning || item.deletedAt !== null" :title="`${item.title}
${item.url}`"
            @click="selecting ? toggle(item.id) : itemAction('open', item)" @auxclick="middleClick($event, item)">
            <img v-if="item.supjav?.thumb" :src="item.supjav.thumb" alt="" loading="lazy" referrerpolicy="no-referrer" class="aspect-[320/216] w-full bg-accented object-cover" />
            <span v-else class="grid aspect-[320/216] w-full place-items-center bg-accented text-muted"><UIcon name="i-lucide-image-off" class="size-6" /></span>
            <span class="line-clamp-2 px-2.5 pt-2 text-sm leading-snug">{{ item.title || '(제목 없음)' }}</span>
          </button>
          <div class="mt-auto flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-xs text-muted">
            <UCheckbox v-if="selecting" :model-value="selected.has(item.id)" :aria-label="`${item.title || '제목 없음'} 선택`" @update:model-value="toggle(item.id)" />
            <span class="min-w-0 flex-1 truncate">{{ STATUS[item.status] }}<template v-if="item.supjav?.date"> · {{ item.supjav.date }}</template></span>
            <UDropdownMenu :items="menu(item)" :content="{ align: 'end' }">
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-ellipsis-vertical" aria-label="항목 메뉴" :disabled="busy" />
            </UDropdownMenu>
          </div>
        </div>
      </div>
      <ul v-else class="flex flex-col gap-1" aria-label="저장 항목">
        <li v-if="result && !result.items.length" class="py-8 text-center text-muted">표시할 항목이 없습니다.</li>
        <li v-for="item in result?.items" :key="item.id" class="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-elevated" :class="{ 'opacity-60': item.status === 'done' || item.deletedAt !== null }">
          <UCheckbox v-if="selecting" :model-value="selected.has(item.id)" :aria-label="`${item.title || '제목 없음'} 선택`" @update:model-value="toggle(item.id)" />
          <span class="grid size-7 shrink-0 place-items-center rounded-md bg-accented text-xs font-bold text-toned" aria-hidden="true">{{ domain(item.url).replace(/^www\./, '').charAt(0).toUpperCase() }}</span>
          <button type="button" class="min-w-0 flex-1 text-left disabled:cursor-default" :disabled="busy || item.warning || item.deletedAt !== null" :title="`${item.title}\n${item.url}`"
            @click="selecting ? toggle(item.id) : itemAction('open', item)" @auxclick="middleClick($event, item)">
            <span class="block truncate font-medium">{{ item.title || '(제목 없음)' }}</span>
            <span class="block truncate text-xs text-muted">{{ STATUS[item.status] }} · {{ domain(item.url) }}<template v-if="item.supjav?.date"> · {{ item.supjav.date }}</template><template v-if="item.warning"> · 제한 URL</template><template v-if="item.note"> · 메모</template><template v-if="(item as any).nyaa?.downloaded?.count"> · 받음</template></span>
          </button>
          <UDropdownMenu :items="menu(item)" :content="{ align: 'end' }">
            <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-ellipsis-vertical" aria-label="항목 메뉴" :disabled="busy" />
          </UDropdownMenu>
        </li>
      </ul>
      <div v-if="result && result.pages > 1" class="flex justify-center">
        <UPagination :page="page" :total="result.total" :items-per-page="50" :sibling-count="wide ? 1 : 0" size="sm" show-edges :disabled="busy" @update:page="goPage" />
      </div>
      </template>

      <UCollapsible v-if="wide && show('backup')" :default-open="wide" class="rounded-lg border border-default">
        <UButton color="neutral" variant="ghost" size="md" block trailing-icon="i-lucide-chevron-down" class="justify-between">내보내기 · 가져오기 · 설정</UButton>
        <template #content>
          <div class="flex flex-col gap-2 p-3 pt-0">
            <div class="flex flex-wrap gap-1.5">
              <UButton size="sm" color="neutral" variant="soft" :disabled="busy" @click="exportJSON">전체 JSON</UButton>
              <UButton size="sm" color="neutral" variant="soft" :disabled="busy" @click="exportText(false)">TXT</UButton>
              <UButton size="sm" color="neutral" variant="soft" :disabled="busy" @click="exportText(true)">HTML</UButton>
              <UButton size="sm" color="neutral" variant="soft" icon="i-lucide-upload" :disabled="busy" @click="importInput?.click()">JSON 가져오기</UButton>
              <input ref="importInput" type="file" accept=".json,application/json" hidden @change="importFile" />
              <UButton size="sm" color="neutral" variant="soft" :disabled="busy" @click="containerPermission">컨테이너 권한 허용 (선택)</UButton>
            </div>
            <p class="text-xs text-muted">휴지통까지 모두 내보냅니다. 가져오기는 기존 ID를 건너뜁니다. 컨테이너 권한은 원래 컨테이너 열기에만 사용합니다.</p>
          </div>
        </template>
      </UCollapsible>

      <section v-if="wide && section === 'sync'" class="flex flex-col gap-3 rounded-lg border border-default p-4" aria-label="hitomi-web 연동">
        <p :class="sync?.status === 'connected' ? 'text-success' : sync?.status === 'off' ? 'text-muted' : 'text-warning'" aria-live="polite">{{ syncText }}</p>
        <div class="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <UFormField label="서버 주소" :help="(sync as any)?.address ? `저장됨 · ${(sync as any).address}` : '저장 안 됨'" :hint="server.url.trim() ? `저장하면 바뀜 · ${vaultLabel(server.url)}` : undefined"><UInput v-model="server.url" type="url" placeholder="http://서버:포트/api/vault/…" spellcheck="false" autocomplete="off" class="w-full" /></UFormField>
          <UFormField label="이 PC 이름"><UInput v-model="server.name" :maxlength="60" placeholder="예: PC A" class="w-full" /></UFormField>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton icon="i-lucide-plug" @click="connectServer">연동 켜기</UButton>
          <UButton color="neutral" variant="soft" icon="i-lucide-refresh-cw" @click="resyncServer">서버 기준으로 다시 받기</UButton>
          <UButton color="neutral" variant="ghost" icon="i-lucide-unplug" @click="disableServer">연동 끄기</UButton>
        </div>
        <p class="text-sm text-muted">연동하면 보관함 기준은 hitomi-web 서버가 되고 이 PC 저장소는 임시 사본으로 쓰입니다. 처음 켤 때 이 PC 항목을 서버로 올리고(같은 URL은 서버 것 유지) 서버 목록으로 맞춥니다. 서버에 연결되지 않으면 변경을 쌓아 두었다가 연결되면 올립니다. 작업 기록·열린 탭·설정은 이 PC에만 남습니다. 주소는 hitomi-web 설정 › API에서 복사하세요.</p>
        <UCollapsible class="rounded-md border border-default" @update:open="o => o && loadSyncLog()">
          <UButton color="neutral" variant="ghost" size="sm" block trailing-icon="i-lucide-chevron-down" class="justify-between">서버 반영 기록(최근 50개)</UButton>
          <template #content>
            <ul class="max-h-64 overflow-auto px-3 pb-2 font-mono text-xs text-muted">
              <li v-if="!syncLogs.length">기록이 없습니다.</li>
              <li v-for="(l, n) in syncLogs" :key="n" :class="l.ok ? '' : 'text-error'">{{ new Date(l.at).toLocaleString('ko-KR', { hour12: false }) }} · {{ l.ok ? `반영 ${l.sent}건 (추가 ${l.added ?? 0} · 건너뜀 ${l.skipped ?? 0}${l.invalid ? ` · 잘못됨 ${l.invalid}` : ''}${l.duplicate ? ' · 중복 전송' : ''})` : `실패 ${l.status ? `HTTP ${l.status} ` : ''}${l.error}` }}</li>
            </ul>
          </template>
        </UCollapsible>
        <p class="text-sm text-muted">LibreWolf는 내부망 http 주소도 https로 바꿔 연결이 실패합니다. about:config에서 dom.security.https_only_mode.upgrade_local을 false로 바꾸세요.</p>
      </section>

      <section v-if="wide && section === 'sync'" class="flex flex-col gap-3 rounded-lg border border-default p-4" aria-label="FC@nyaa 연동">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="font-semibold">FC@nyaa (nyaa.exe) 연동</h2>
          <span :class="fc?.status === 'connected' ? 'text-success' : fc?.status === 'off' ? 'text-muted' : 'text-warning'" class="text-sm" aria-live="polite">{{ fcText }}</span>
        </div>
        <p class="text-sm text-muted">같은 PC에서 실행 중인 nyaa.exe와 연결합니다. nyaa의 단축키를 누르면 이 브라우저의 현재 탭에서 품번을 뽑아 보내고, 탭 닫기·복구와 supjav 영상 재생/정지를 처리합니다. supjav 페이지를 열면 열람 기록을 nyaa에 남깁니다. (예전 FC2 Player Controller 유저스크립트는 꺼 주세요.)</p>
        <div class="grid gap-3 sm:grid-cols-[1fr_auto]">
          <UFormField label="nyaa 주소"><UInput v-model="fcUrl" type="url" placeholder="http://127.0.0.1:18232" spellcheck="false" autocomplete="off" class="w-full" /></UFormField>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton icon="i-lucide-plug" @click="configureFc(true)">연동 켜기</UButton>
          <UButton color="neutral" variant="ghost" icon="i-lucide-unplug" @click="configureFc(false)">연동 끄기</UButton>
          <UButton color="neutral" variant="soft" :icon="fcMedia ? 'i-lucide-check' : 'i-lucide-shield'" :disabled="fcMedia" @click="allowFcMedia">{{ fcMedia ? '영상 제어 권한 허용됨' : '영상 제어 권한 허용' }}</UButton>
        </div>
        <p class="text-xs text-muted">영상 제어 권한: supjav 플레이어는 다른 도메인의 iframe 안에 있어 모든 사이트 접근 권한이 있어야 재생/정지를 제어할 수 있습니다. 영상 제어에만 씁니다.</p>
        <UCollapsible class="rounded-md border border-default" @update:open="o => o && loadFc()">
          <UButton color="neutral" variant="ghost" size="sm" block trailing-icon="i-lucide-chevron-down" class="justify-between">최근 처리 기록(이번 실행)</UButton>
          <template #content>
            <ul class="max-h-64 overflow-auto px-3 pb-2 font-mono text-xs text-muted">
              <li v-if="!fc?.log?.length">기록이 없습니다.</li>
              <li v-for="(l, n) in fc?.log || []" :key="n" :class="l.ok ? '' : 'text-error'">{{ new Date(l.at).toLocaleTimeString('ko-KR', { hour12: false }) }} · {{ l.text }}</li>
            </ul>
          </template>
        </UCollapsible>
      </section>

      <p v-if="wide && show('backup')" class="text-xs text-dimmed">확장 삭제 시 이 PC 사본이 사라질 수 있습니다. 서버 연동 중이면 서버에 남습니다. JSON 백업을 보관하세요.</p>
    </div>

    <UModal v-model:open="info.open" title="상세 정보" :description="info.item?.title || '(제목 없음)'">
      <template #body>
        <div v-if="info.item" class="flex flex-col gap-3 text-sm">
          <img v-if="info.item.supjav?.thumb" :src="info.item.supjav.thumb" alt="" referrerpolicy="no-referrer" class="w-full rounded-md bg-accented object-contain" />
          <a :href="info.item.url" target="_blank" rel="noreferrer noopener" class="break-all text-primary hover:underline">{{ info.item.url }}</a>
          <dl class="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5">
            <template v-for="r in detailRows" :key="r[0]"><dt class="text-muted">{{ r[0] }}</dt><dd class="break-words whitespace-pre-wrap">{{ r[1] }}</dd></template>
            <dt class="text-muted">품번</dt>
            <dd class="flex flex-wrap items-center gap-2">
              <span class="font-mono">{{ (info.item as any).code || '(없음)' }}</span>
              <UInput v-model="codeInput" size="xs" class="w-40" placeholder="직접 입력 (비우면 자동)" aria-label="품번 직접 입력" />
              <UButton size="xs" color="neutral" variant="soft" @click="saveCode">적용</UButton>
            </dd>
          </dl>
        </div>
      </template>
    </UModal>
    <UModal v-model:open="edit.open" title="메모와 태그" :description="edit.item?.title">
      <template #body>
        <div class="flex flex-col gap-3">
          <UFormField label="메모"><UTextarea v-model="edit.note" :rows="6" :maxlength="100000" class="w-full" /></UFormField>
          <UFormField label="태그 (쉼표로 구분)"><UInput v-model="edit.tags" :maxlength="10000" class="w-full" /></UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="edit.open = false">취소</UButton>
          <UButton :disabled="busy" @click="saveEdit">저장</UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="ask.open" :title="ask.title" :description="ask.description || undefined">
      <template v-if="ask.typed" #body>
        <UInput v-model="ask.input" :placeholder="ask.typed" class="w-full" autofocus @keydown.enter="ask.input === ask.typed && closeAsk(true)" />
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="closeAsk(false)">취소</UButton>
          <UButton :color="ask.color" :disabled="!!ask.typed && ask.input !== ask.typed" @click="closeAsk(true)">{{ ask.confirm }}</UButton>
        </div>
      </template>
    </UModal>
  </UApp>
</template>

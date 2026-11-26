// 새 확장 화면(VaultPanel·수집 목록)을 jsdom에서 실제로 띄워 보는 테스트.
// Nuxt UI 부품은 간단한 대역 부품으로 바꾸고, 화면이 백그라운드에 보내는 메시지를 확인한다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { parse, compileScript } from '@vue/compiler-sfc'
import ts from 'typescript'

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://extension.invalid/' })
for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'MouseEvent', 'Event', 'KeyboardEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key] ?? dom.window, configurable: true, writable: true })
}
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0)
globalThis.IntersectionObserver = class { observe() {} disconnect() {} }
const toasts = []
globalThis.useToast = () => ({ add: t => toasts.push(t) })
const { createApp, defineComponent, h, nextTick } = await import('vue')

// SFC → ESM 파일로 컴파일(상대 import는 실제 파일 경로로 바꿈)
const SRC = new URL('../src/', import.meta.url), OUT = new URL('../.test-build/', import.meta.url)
await mkdir(OUT, { recursive: true })
async function compile(rel) {
  const file = new URL(rel, SRC)
  const { descriptor } = parse(await readFile(file, 'utf8'))
  let code = ts.transpileModule(compileScript(descriptor, { id: rel, inlineTemplate: true }).content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  code = code.replace(/from '(\.[^']+)'/g, (_, p) => {
    if (p.endsWith('rpc')) return `from '${new URL('rpc.mjs', OUT).href}'`
    return `from '${new URL(p, file).href}'`
  })
  const out = new URL(rel.replace(/\//g, '_') + '.mjs', OUT)
  await writeFile(out, code)
  return (await import(out.href)).default
}
await writeFile(new URL('rpc.mjs', OUT), ts.transpileModule(await readFile(new URL('rpc.ts', SRC), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText)

// Nuxt UI 대역 부품
const pass = tag => defineComponent({ inheritAttrs: false, setup: (_, { slots, attrs }) => () => h(tag, attrs, slots.default?.()) })
const stubs = {
  UApp: pass('div'), UBadge: pass('span'), UFormField: pass('label'), UIcon: pass('i'), UPagination: pass('nav'), UAlert: defineComponent({ props: ['title'], setup: p => () => h('div', p.title) }),
  UCard: defineComponent({ setup: (_, { slots }) => () => h('article', [slots.default?.(), slots.footer?.()]) }),
  UButton: defineComponent({ inheritAttrs: false, props: ['disabled', 'icon'], emits: ['click'], setup: (p, { slots, attrs, emit }) => () => h('button', { 'aria-label': attrs['aria-label'], disabled: p.disabled, onClick: e => emit('click', e) }, slots.default?.()) }),
  USwitch: defineComponent({ inheritAttrs: false, props: ['modelValue', 'label', 'disabled'], emits: ['update:modelValue'], setup: (p, { emit }) => () => h('input', { type: 'checkbox', role: 'switch', 'aria-label': p.label, checked: p.modelValue, onChange: e => emit('update:modelValue', e.target.checked) }) }),
  UCheckbox: defineComponent({ inheritAttrs: false, props: ['modelValue', 'label', 'disabled'], emits: ['update:modelValue'], setup: (p, { emit }) => () => h('input', { type: 'checkbox', 'aria-label': p.label, checked: p.modelValue, disabled: p.disabled, onChange: e => emit('update:modelValue', e.target.checked) }) }),
  UInput: defineComponent({ inheritAttrs: false, props: ['modelValue', 'placeholder', 'type'], emits: ['update:modelValue'], setup: (p, { emit, attrs }) => () => h('input', { 'aria-label': attrs['aria-label'], placeholder: p.placeholder, type: p.type, value: p.modelValue, onInput: e => emit('update:modelValue', e.target.value) }) }),
  UInputNumber: defineComponent({ inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup: (p, { emit }) => () => h('input', { type: 'number', value: p.modelValue, onInput: e => emit('update:modelValue', Number(e.target.value)) }) }),
  UTextarea: defineComponent({ inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup: (p, { emit }) => () => h('textarea', { value: p.modelValue, onInput: e => emit('update:modelValue', e.target.value) }) }),
  USelect: defineComponent({ inheritAttrs: false, props: ['modelValue', 'items'], emits: ['update:modelValue'], setup: (p, { emit, attrs }) => () => h('select', { 'aria-label': attrs['aria-label'], value: p.modelValue, onChange: e => emit('update:modelValue', e.target.value) }, p.items.map(i => h('option', { value: i.value }, i.label))) }),
  UTabs: defineComponent({ props: ['modelValue', 'items'], emits: ['update:modelValue'], setup: (p, { emit }) => () => h('div', { role: 'tablist' }, p.items.map(i => h('button', { role: 'tab', 'aria-selected': String(p.modelValue === i.value), onClick: () => emit('update:modelValue', i.value) }, i.label))) }),
  UDropdownMenu: defineComponent({ props: ['items'], setup: (p, { slots }) => () => h('div', [slots.default?.(), ...p.items.flat().map(i => h('button', { 'data-menu': i.label, disabled: i.disabled, onClick: i.onSelect }, i.label))]) }),
  UCollapsible: defineComponent({ props: ['open'], setup: (_, { slots }) => () => h('div', [slots.default?.(), slots.content?.()]) }),
  UModal: defineComponent({ props: ['open', 'title', 'description'], setup: (p, { slots }) => () => p.open ? h('div', { role: 'dialog', 'aria-label': p.title }, [h('h2', p.title), p.description && h('p', p.description), slots.body?.(), slots.footer?.()]) : null }),
}

function backend(overrides = {}) {
  const calls = []
  let listener
  globalThis.browser = {
    windows: { getCurrent: async () => ({ id: 42 }) },
    tabs: { create: o => calls.push({ action: 'tabs.create', args: o }) },
    permissions: { request: async o => { calls.push({ action: 'permissions.request', args: o }); return true } },
    runtime: {
      getURL: p => 'moz-extension://x/' + p,
      onMessage: { addListener: f => { listener = f }, removeListener() {} },
      sendMessage: async ({ action, args }) => {
        calls.push({ action, args })
        const fixed = {
          list: { page: 1, pages: 40, total: 2000, items: [{ id: 'a', url: 'https://www.example.com/x', title: '예시', status: 'unread', note: '', tags: [], createdAt: 1, deletedAt: null, sources: [] }], counts: { total: 2000, unread: 1990, reviewing: 10, done: 3, trash: 2 } },
          autoSyncState: { enabled: false }, setAutoSync: { enabled: args?.enabled }, syncInfo: { status: 'connected', pending: 0 }, supjavList: { running: false, last: null },
          captureStart: { id: 'job', captured: 10, created: 8, loading: 1 }, captureClose: { closed: 10, kept: 0 }, busyState: { busy: null }, prepareEmptyTrash: { ids: ['t1', 't2'] }, emptyTrash: { removed: 2 }, syncConfigure: { status: 'connecting' },
        }
        const result = action in overrides ? overrides[action](args) : fixed[action] ?? {}
        return { ok: true, result: structuredClone(result) }
      },
    },
  }
  return { calls, emit: m => listener?.(m) }
}
async function mount(Component, props = {}) {
  document.body.innerHTML = '<div id="app"></div>'
  const app = createApp(Component, props)
  for (const [n, c] of Object.entries(stubs)) app.component(n, c)
  app.mount('#app')
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); await nextTick() }
  return app
}
const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); await nextTick() } }
const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const VaultPanel = await compile('VaultPanel.vue')

test('sidebar: count, work switch, supjav range and capture send the same messages as before', async () => {
  const b = backend()
  const app = await mount(VaultPanel, { layout: 'sidebar' })
  assert.match(document.querySelector('h1').textContent, /미완료 2,000개/)
  assert.ok(document.querySelector('input[type=number]'), 'supjav 최대 쪽 수 칸이 사이드패널에 보여야 함')
  const sw = document.querySelector('[role=switch]'); sw.checked = true; sw.dispatchEvent(new Event('change')); await settle()
  assert.deepEqual(b.calls.find(c => c.action === 'setAutoSync').args, { enabled: true })
  button('열린 탭 보관').click(); await settle()
  assert.deepEqual(b.calls.find(c => c.action === 'captureStart').args, { scope: 'current', windowId: 42, dedupe: true })
  assert.equal(b.calls.some(c => c.action === 'captureClose'), false, '확인창 전에는 닫지 않음')
  assert.match(document.body.textContent, /탭 10개를 닫을까요/)
  button('취소').click(); await settle()
  assert.equal(b.calls.some(c => c.action === 'captureClose'), false, '취소하면 닫지 않음')
  assert.ok(b.calls.some(c => c.action === 'captureCancel'))
  assert.equal(document.body.textContent.includes('내보내기 · 가져오기'), false, '사이드패널에는 내보내기 칸 없음')
  localStorage.setItem('capture-confirm', '0'); app.unmount()
  const app2 = await mount(VaultPanel, { layout: 'sidebar' })
  button('열린 탭 보관').click(); await settle()
  assert.deepEqual(b.calls.filter(c => c.action === 'captureClose').map(c => c.args), [{ jobId: 'job' }], '확인창 설정 꺼짐이면 바로 닫기')
  localStorage.removeItem('capture-confirm'); app2.unmount()
})

test('empty trash needs the confirmation dialog; cancel sends nothing destructive', async () => {
  const b = backend()
  const app = await mount(VaultPanel, { layout: 'sidebar' })
  ;[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.startsWith('휴지통')).click(); await settle()
  button('휴지통 비우기').click(); await settle()
  assert.ok(document.querySelector('[role=dialog]'))
  assert.equal(b.calls.some(c => c.action === 'emptyTrash'), false)
  button('취소').click(); await settle()
  assert.equal(b.calls.some(c => c.action === 'emptyTrash'), false)
  button('휴지통 비우기').click(); await settle()
  button('영구 삭제').click(); await settle()
  assert.deepEqual(b.calls.find(c => c.action === 'emptyTrash').args, { ids: ['t1', 't2'], confirmed: true })
  app.unmount()
})

test('item menu and bulk actions', async () => {
  const b = backend()
  const app = await mount(VaultPanel, { layout: 'sidebar' })
  document.querySelector('[data-menu="완료"]').click(); await settle()
  assert.deepEqual(b.calls.find(c => c.action === 'mutate').args, { ids: ['a'], action: 'status', status: 'done' })
  button('선택').click(); await settle()
  document.querySelector('input[aria-label="이 쪽 전체"]').dispatchEvent(Object.assign(new Event('change'), {}));
  const all = document.querySelector('input[aria-label="이 쪽 전체"]'); all.checked = true; all.dispatchEvent(new Event('change')); await settle()
  button('휴지통').click(); await settle()
  button('휴지통으로 이동').click(); await settle()
  assert.deepEqual(b.calls.filter(c => c.action === 'mutate').at(-1).args, { ids: ['a'], action: 'delete', status: 'done' })
  app.unmount()
})

test('manager: five tabs and the sync tab asks permission without a port before connecting', async () => {
  const b = backend()
  const app = await mount(VaultPanel, { layout: 'manager' })
  const tabs = [...document.querySelectorAll('[role=tab]')].map(t => t.textContent)
  for (const name of ['보관함', '열린 탭 보관', 'supjav', '백업', '연동']) assert.ok(tabs.includes(name), name)
  ;[...document.querySelectorAll('[role=tab]')].find(t => t.textContent === '연동').click(); await settle()
  const url = document.querySelector('input[type=url]')
  url.value = 'http://bad'; url.dispatchEvent(new Event('input')); button('연동 켜기').click(); await settle()
  assert.equal(b.calls.some(c => c.action === 'syncConfigure'), false)
  url.value = `http://10.0.0.5:8080/api/vault/${'a'.repeat(64)}`; url.dispatchEvent(new Event('input')); button('연동 켜기').click(); await settle()
  assert.deepEqual(b.calls.find(c => c.action === 'permissions.request').args, { origins: ['http://10.0.0.5/*'] })
  assert.equal(b.calls.find(c => c.action === 'syncConfigure').args.url, `http://10.0.0.5:8080/api/vault/${'a'.repeat(64)}`)
  app.unmount()
})

test('new screens never use browser confirm/prompt or raw HTML', async () => {
  const files = ['VaultPanel.vue']
  for (const f of files) {
    const s = await readFile(new URL(f, SRC), 'utf8')
    assert.doesNotMatch(s, /\bconfirm\(|\bprompt\(|v-html/, f)
  }
})

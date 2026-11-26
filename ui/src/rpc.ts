// 확장 백그라운드와 통신. 메시지 형식은 기존 화면(manager.js)과 같다: { action, args } → { ok, result | error }
declare const browser: any
// 실행 시점의 browser 객체를 그때그때 읽는다(테스트에서 가짜 browser로 바꿀 수 있게).
export const ext: any = new Proxy({}, { get: (_, key) => (globalThis as any).browser[key] })

export async function rpc<T = any>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await ext.runtime.sendMessage({ action, args })
  if (!response?.ok) throw new Error(response?.error || '백그라운드와 연결하지 못했습니다. 화면을 다시 여세요.')
  if (['mutate'].includes(action)) changes?.postMessage('changed')
  return response.result as T
}
// 다른 확장 화면(사이드패널·관리 화면)에 변경을 알리는 채널. 기존 화면과 같은 이름.
export const changes = typeof BroadcastChannel === 'function' ? new BroadcastChannel('local-tab-vault-changes') : null

export type VaultItem = {
  id: string; url: string; title: string; status: 'unread' | 'reviewing' | 'done'; note: string; tags: string[]
  createdAt: number; updatedAt: number; completedAt: number | null; lastViewedAt?: number | null; deletedAt: number | null
  supjav?: { id?: string; thumb?: string | null; date?: string | null }
}
export type SyncInfo = { status: 'off' | 'connecting' | 'connected' | 'offline' | 'unauthorized'; error: string; enabled: boolean; name: string; pending: number; lastSync: number | null }

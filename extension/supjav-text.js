export const REASONS = {
  'caught-up': '새 게시물이 없는 쪽에서 멈춤', 'date-reached': '정한 날짜보다 오래된 글이 나와 멈춤', limit: '최대 쪽 수까지 읽음',
  end: '마지막 쪽까지 읽음', stopped: '중지 버튼으로 멈춤',
  challenge: 'Cloudflare 확인 화면을 3분 안에 통과하지 않아 멈춤',
  network: '읽기 오류로 멈춤', timeout: '페이지가 열리지 않아 멈춤', 'tab-closed': '수집하던 탭이 닫혀 멈춤',
  'tab-moved': '수집 중에 탭이 다른 페이지로 이동해 멈춤', http: '사이트가 오류 응답을 보내 멈춤',
  structure: '목록에서 게시물을 찾지 못함 (사이트 구조 변경 가능)'
};

export function describeRun(last) {
  if (!last) return '아직 수집 기록 없음';
  const d = last.detail;
  const info = d && !['caught-up', 'date-reached', 'limit', 'stopped'].includes(last.reason)
    ? ` (진단: ${d.page}쪽${d.status ? ` · HTTP ${d.status}` : ''}${d.title ? ` · 제목 "${d.title}"` : ''}${d.error ? ` · ${d.error} ${d.message}` : ''})` : '';
  const range = last.mode === 'date' ? `${last.untilDate}까지 · ` : '';
  const vault = last.vault ? ` · 보관함에 ${last.vault.added}개 추가${last.vault.skipped ? `(이미 있음 ${last.vault.skipped}개)` : ''}` : last.vaultError ? ` · 보관함 추가 실패: ${last.vaultError}` : '';
  return `${range}${last.pages}쪽 읽음${last.lastPage ? `(마지막 ${last.lastPage}쪽)` : ''}, 새 게시물 ${last.added}개, 변경 ${last.updated}개${vault} · ${REASONS[last.reason] || last.reason}${info}`;
}

export function describeProgress(m) {
  return `${m.page}쪽 ${m.stage === 'response' ? '읽는 중' : '여는 중'}… (${m.step}번째 쪽) · 새 게시물 ${m.added}개`;
}

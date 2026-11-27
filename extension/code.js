// 품번 규칙: AHK(FC@nyaa.ahk) ExtractByTitle 그대로, 제목만 본다.
// 확장 보관함·nyaa 연동(단축키 추출·열람 기록)이 모두 이 함수만 쓴다.
// 규칙 문서: hitomi-web/fc-nyaa/docs/query-normalization.md, 계획: code-db-plan.md

export function extractCode(title = '') {
  const s = String(title);
  const t = s.toLowerCase();
  let m;
  if (t.includes('1pondo') || s.includes('一本道')) return (m = s.match(/\d{6}[_-]\d{3}/)) ? `${m[0]}-1PON` : null;
  if (t.includes('10musume') || s.includes('天然むすめ')) return (m = s.match(/\d{6}[_-]\d{2,3}/)) ? `${m[0]}-10MU` : null;
  if (t.includes('caribbeancom') || s.includes('カリビアンコム')) return (m = s.match(/\d{6}[_-]\d{3}/)) ? `${m[0]}-CARIB` : null;
  if (t.includes('pacopacomama') || s.includes('パコパコママ')) return (m = s.match(/\d{6}[_-]\d{3}/)) ? `${m[0]}-PACO` : null;
  if (t.includes('heyzo')) return (m = s.match(/HEYZO\s+(\d{3,4})/i)) ? `HEYZO ${m[1]}` : null;
  if (t.includes('fc2')) return (m = s.match(/(?<!\d)\d{7,10}(?!\d)/)) ? m[0] : null;
  return null;
}

// nyaa normalize_query와 같음: 대문자 + '-' 제거
export const codeKey = code => (code ? String(code).toUpperCase().replaceAll('-', '') : null);

// 항목에 code·codeKey를 채운다 (직접 입력한 codeManual이 있으면 그것을 우선). 바뀌었으면 true.
export function applyCode(item) {
  if (!item || typeof item !== 'object') return false;
  const manual = typeof item.codeManual === 'string' && item.codeManual.trim() ? item.codeManual.trim() : null;
  const code = manual || extractCode(item.title);
  const key = codeKey(code);
  if (item.code === code && item.codeKey === key) return false;
  item.code = code; item.codeKey = key;
  return true;
}

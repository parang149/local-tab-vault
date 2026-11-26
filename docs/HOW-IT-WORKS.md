# 탭 보관함 확장 작동 방식과 작업 내역

나중에 참고하려고 정리한 문서입니다. 코드를 고치기 전에 먼저 읽어 두면 좋습니다.

## 1. 전체 그림

```
 [LibreWolf/Floorp 확장]                         [hitomi-web 서버]                 [WEBUI(폰·PC)]
  사이드패널·관리 화면·수집 목록                    data/vault.sqlite3 (기준)          supjav 탭
        │ rpc 메시지                                     ▲  │ SSE 알림                       ▲
  background.js ── service.js ── db.js(IndexedDB 캐시) ──┤  ▼                                │
        │            ▲              └ outbox(미반영 대기열)│ POST/GET /api/vault/{토큰}     │ /api/supjav/*
  collector.js(supjav 수집)   sync.js(서버 동기화) ────────┘                                │(로그인 세션)
```

- **진짜 보관함은 서버**(`data/vault.sqlite3`)다. 각 PC 확장의 IndexedDB는 서버 내용의 사본(캐시)과 아직 못 올린 변경 대기열만 가진다.
- 서버 연동을 끄면 예전처럼 PC 혼자 쓰는 보관함으로 동작한다.

## 2. 확장 파일별 역할

| 파일 | 역할 |
|---|---|
| `extension/manifest.json` | ID `local-tab-vault@local.invalid`, 권한, CSP. 시험판 버전은 네 자리(1.13.0.1) |
| `extension/background.js` | 화면 메시지 받기, 탭 이벤트, supjav 수집 시작, 동기화 시작 |
| `extension/service.js` | 보관함 동작(보관, 탭 닫기 안전 규칙, 상태 변경, 백업, 가져오기, supjav 항목 추가) |
| `extension/db.js` | IndexedDB `local-tab-vault-v1`(v4). `commit()`이 항목 변경을 같은 트랜잭션에서 `outbox`에 기록 |
| `extension/sync.js` | 서버 동기화(`ServerSync`) |
| `extension/collector.js` | supjav 일본어 목록 읽기와 파싱, 사용자가 연 탭에서 쪽 넘기기 |
| `extension/supjav-text.js` | 수집 결과·진행 문구(옛 화면과 새 화면이 같이 씀) |
| `ui/src/VaultPanel.vue` | 사이드패널과 관리 화면이 같이 쓰는 보관함 화면. `layout='sidebar'`이면 모든 영역을 세로로, `'manager'`이면 위쪽 탭 5개로 나눔 |
| `ui/` | **새 화면 소스**(Vue 3 + Nuxt UI 4.12 + Tailwind 4). 빌드하면 `extension/ui/`가 생김 |
| `extension/ui/` | 빌드 결과물. 직접 고치지 않는다(.gitignore) |

## 3. 빌드와 설치

```
cd firefox-extension
npm --prefix ui install      # 처음 한 번 (ui/node_modules)
npm run build                # ui 빌드 → extension/ui/ → dist/local-tab-vault-<버전>
npm test                     # 동작 테스트(tests/*.test.js) + 화면 테스트(ui/tests/*.test.mjs)
```

- LibreWolf에서는 `about:debugging` → 임시 부가 기능 로드 → `dist/local-tab-vault-<버전>/manifest.json`을 고른다. 이미 로드돼 있으면 **다시 로드**를 누른다. ID가 같으므로 데이터는 유지된다.
- 새 화면 테마는 hitomi-web `frontend/vite.config.ts`와 같은 값(primary emerald, neutral zinc, 기본 크기 lg)이다. 지금은 `<html class="dark">`로 항상 어둡게 보인다. 색은 Nuxt UI 변수만 쓰므로, 밝은 테마는 나중에 클래스만 바꿔서 추가할 수 있다.
- 아이콘은 `ui/vite.config.ts`의 `icon.clientBundle.icons`에 넣어 빌드에 포함한다. 새 아이콘을 쓰면 여기에 추가해야 한다. 빠뜨리면 외부 아이콘 서버에 요청할 수 있다.
- CSP는 `style-src 'self' 'unsafe-inline'`이다. Nuxt UI가 실행 중에 색 변수 `<style>`이나 팝업 위치 style을 넣기 때문이다. 스크립트 정책은 `'self'`만 허용한 그대로다.

## 4. 화면 ↔ 백그라운드 메시지

화면은 `browser.runtime.sendMessage({ action, args })`로 요청하고 `{ ok, result | error }`를 받는다(`ui/src/rpc.ts`).

- 보관함 동작은 `service.js`의 메서드 이름과 같다. 예: `list`, `mutate`, `capture`, `exportJSON`.
  - 허용 목록은 `background.js`의 `actions`이다.
  - 보낼 수 있는 화면은 `ui/manager.html`, `ui/sidebar.html`, `ui/collector.html`뿐이다(`background.js`의 `pages`, `manager`, `sidebar` 상수). `service.openManager`도 `ui/manager.html`을 연다.
- 수집·동기화 메시지:
  - `supjavItems`: 보관함의 supjav 항목. 수집 목록 화면이 쓴다.
  - `supjavStart`, `supjavStop`, `supjavList`: 수집 시작, 중지, 마지막 결과
  - `syncInfo`, `syncConfigure`, `syncDisable`, `syncResync`: 동기화 상태와 설정
- 백그라운드가 화면으로 보내는 알림:
  - `local-tab-vault-live`: 보관함이 바뀜. 화면은 목록을 다시 읽는다.
  - `vault-sync-status`: 동기화 상태
  - `supjav-progress`, `supjav-challenge`, `supjav-done`: 수집 진행, Cloudflare 확인 화면, 완료
- 화면끼리는 BroadcastChannel `local-tab-vault-changes`로 "바뀜"을 알린다.

## 5. supjav 수집

1. 사용자가 `https://supjav.com/ja/category/uncensored-jav`(또는 `/page/N`)를 연 탭에서 사이드패널 **수집**을 누른다.
2. `collector.js`가 **그 탭 하나**로 쪽을 넘기며 HTML을 읽는다. 새 탭을 열지 않고, 끝나면 마지막 쪽에 머문다. 쪽 사이 간격은 1~1.5초다.
3. Cloudflare 확인 화면이 나오면 사용자가 그 탭에서 직접 통과할 때까지 최대 3분 기다린다. 자동 통과나 우회는 하지 않는다.
4. 멈추는 조건:
   - 새 글만 모드: 새 글이 없는 쪽에서 멈춘다(최대 N쪽).
   - 날짜 모드: 정한 날짜보다 오래된 글이 나오면 멈춘다.
5. **새 글 판단은 보관함 기준**이다. 보관함에 있는 supjav 글 번호는 다른 PC에서 수집한 글, 완료한 글, 휴지통의 글을 포함해 모두 "이미 받은 글"로 친다.
6. 결과는 `service.addCollected`가 보관함 항목으로 넣는다.
   - 미확인 상태, `supjav` 태그를 붙이고, 오래된 글부터 넣는다.
   - 같은 URL은 건너뛴다.
   - 썸네일과 게시일은 `item.supjav`에 저장한다.
   - 서버에는 `merge`로 보내므로, 서버에 같은 URL이 있으면 서버가 건너뛴다.
7. 휴지통의 글은 다시 수집하지 않는다. **휴지통 비우기(완전 삭제)**를 한 글만 다시 새 글이 될 수 있다.

## 6. 서버 동기화

**주소와 토큰**
- hitomi-web **설정 › API › 탭 보관함 연동**에서 만든다. 형식은 `http(s)://서버/api/vault/{64자리}`이다.
- 라이브러리 API 토큰과는 별개다. 재발급하면 모든 PC 연결이 끊긴다.

**서버 쪽 (`backend/src/vault.rs`)**
- 항목은 JSON 그대로 저장하고, 바뀔 때마다 전체 순번 `rev`를 붙인다. 완전 삭제는 내용을 비운 행(묘비)으로 남긴다.
- 올리기 `POST /api/vault/{토큰}`
  - PC마다 `client_id`와 `sequence`를 보낸다. 같은 순번은 중복으로 무시하고, 순번이 빠지면 409와 `expected=N`을 돌려준다.
  - `add`: 칸 덮어쓰기
  - `patch`: 바뀐 칸만, 서버에 도착한 순서대로 적용
  - `merge`: 같은 ID나 같은 URL이 살아 있으면 건너뜀
  - `delete`: 묘비 남기기
  - 형식이 잘못된 항목은 그 항목만 건너뛰고 `invalid` 수를 알려 준다.
- 받기 `GET /api/vault/{토큰}?after=rev`: rev 순서로 500개씩
- 실시간 알림 `GET /api/vault/{토큰}/events`: SSE. 바뀔 때마다 최신 rev를 보낸다.
- 토큰 경로는 로그인 없이 통과하고(`auth.rs` guard, `vault::is_token_path`), 다른 출처 요청(CORS)도 허용한다. 토큰이 인증이고 쿠키는 쓰지 않는다.
- WEBUI는 로그인 세션으로 `/api/supjav/items`(목록, 상태 수정)와 `/api/supjav/events`를 쓴다.
- 올리기가 실패하면 서버 콘솔에 `[보관함 동기화] 올리기 실패 HTTP …`가 찍힌다.

**확장 쪽 (`sync.js`)**
- **처음 연결**: 이 PC 항목 전체를 `merge`로 200개씩 올린 뒤, 서버 전체를 받아 캐시를 서버와 똑같이 맞춘다.
- **평소**:
  - 화면 작업으로 항목이 바뀌면 `db.commit`이 `outbox`에 기록하고, 약 1초 뒤 묶어서 올린다.
  - SSE 알림이 오면 받기를 한다.
  - 아직 못 올린 변경이 있는 항목은 서버 내용으로 덮지 않는다.
- 서버 내용 반영은 `service.run` 작업 큐 안에서 한다. 화면 작업의 "읽고-고쳐-저장" 사이에 끼어들어 변경이 사라지지 않게 하기 위해서다.
- **연결이 끊기면**: 변경을 대기열에 쌓는다. 1초부터 최대 1분까지 간격을 늘려 다시 연결하고, 연결되면 대기열 → 놓친 변경 → 실시간 순서로 맞춘다.
- 401이면 멈추고 새 주소를 넣으라고 안내한다.
- 탭 제목의 깨진 이모지(짝 없는 서러게이트)는 보낼 때 U+FFFD로 바꾼다. serde_json이 거부하기 때문이다.
- 백업 내보내기에는 연동 설정(토큰)을 넣지 않는다.

**서버에 올리지 않는 것**: 작업 기록, 체크포인트, 열린 작업 탭, 확장 설정은 PC마다 따로 둔다.

## 7. 알려진 함정

- **LibreWolf는 HTTPS 전용 모드가 강제**이고, `dom.security.https_only_mode.upgrade_local=true`라서 내부망 http 주소도 https로 바꾼다. 그러면 확장 상태가 "서버에 연결되지 않음"이 되고, 서버에는 요청이 하나도 오지 않는다.
  - 해결: `about:config`에서 `dom.security.https_only_mode.upgrade_local`을 `false`로 바꾸거나, hitomi-web을 https로 연다.
- 확장 데이터는 브라우저와 프로필마다 따로다. 예: Floorp 보관함 2,017개, LibreWolf 보관함 1,523개. 연동하면 같은 URL끼리 하나로 합쳐진다.
- Floorp에는 1.7.0이 영구 설치되어 있다. 이 PC에서 시험하는 브라우저는 LibreWolf다.

## 8. 작업 내역

| 버전 | 날짜 | 내용 |
|---|---|---|
| 1.8.0~1.9.0 | 2026-11-25 | supjav 수집 시험. 백그라운드 fetch는 Cloudflare 403을 받아 실제 탭 방식으로 바꿈 |
| 1.10.0~1.10.1 | 2026-11-25 | 사용자가 연 일본어 목록 탭에서 수집하게 함. 범위 설정 칸이 안 보이던 문제 수정 |
| 1.11.0 | 2026-11-25 | 수집 결과를 보관함 항목으로 넣음. 최신순 정렬, 작업 방향이 정렬을 따름 |
| 1.12.0 | 2026-11-25 | 원래 ID로 복귀. 서버 기준 실시간 동기화(서버 0.5.9-test1, WEBUI 0.2.8-test1, API 9). LibreWolf에서 연동 확인(서버 1,522개) |
| 1.13.0.1 | 2026-11-25 | 화면 개편 1단계. `ui/` Vue + Nuxt UI 프로젝트, **수집 목록 화면 새로 만듦** |
| 1.13.0.2 | 2026-11-25 | **사이드패널 새로 만듦**(manifest `default_panel` = `ui/sidebar.html`) |
| 1.13.0 | 2026-11-25 | 화면 개편 완료. 옛 화면 파일 삭제, 화면 테스트를 새 화면 기준으로 교체 |
| 1.13.0.3 | 2026-11-25 | **관리 화면 새로 만듦**(탭 5개, manifest `options_ui` = `ui/manager.html`). 사이드패널과 같은 `VaultPanel.vue` 사용 |

**1.13.0.1 수집 목록 화면 (`ui/src/collector/App.vue`, `extension/ui/collector.html`)**
- 보관함의 supjav 항목(서버 기준 캐시)을 썸네일 카드로 보여 준다. 사이드패널의 "수집 목록 ↗"로 연다.
- 표시 탭: 완료 제외(기본) / 미확인 / 완료 / 휴지통 / 전체, 각 개수 표시. 제목·주소·메모로 검색한다.
- 게시일 최신순으로 보여 주고, 60개씩 나눠 그린다.
- 카드마다 완료↔안 봄, 휴지통↔복원 버튼이 있다. 상태는 `mutate`로 바꾸고, 바꾼 내용은 서버와 다른 PC, WEBUI에 실시간 반영된다.
- 위쪽에 연동 상태(연결됨, 미반영 수), 마지막 수집 결과, 수집 진행 문구를 보여 준다. JSON 내보내기는 지금 보이는 목록만 내보낸다.
- 옛 `collector.html`, `collector-page.js`, `collector.css`는 지웠다. 별도 수집 기록 DB(`supjav-collector-v1`)는 마지막 수집 결과 표시와 기록용으로만 남겼다.
- 확인한 것:
  - 테스트 53개 통과
  - 빌드 결과에 외부 요청이 없는 것(아이콘은 빌드에 포함, iconify 주소는 대체 경로 문자열로만 있음)
  - 가짜 데이터로 미리보기 화면에서 상태 변경과 개수 갱신이 되는 것
- 아직 확인하지 않은 것: 실제 LibreWolf에서의 CSP와 화면

**1.13.0.2 사이드패널**
- 옛 사이드패널(`sidebar.html` + `manager.js` compact)의 기능을 모두 옮겼다.
- 위에서부터 이렇게 배치했다.
  - 미완료 개수, 수집 버튼, 전체 화면 버튼
  - 작업 시작 스위치와 연동 상태 칩
  - supjav 수집 카드: 범위, 최대 쪽 수 또는 날짜, 수집 목록, 중지, 진행 문구. 설정은 localStorage `supjav-collect`에 저장한다.
  - 저장 범위와 열린 탭 보관
  - 미완료 / 완료 / 전체 / 휴지통 탭, 검색, 정렬, 새로고침
  - 목록과 쪽 이동
  - 접는 칸 두 개: "열린 탭 저장 · 백업 · 닫기", "내보내기 · 가져오기 · 설정"
- 목록 행은 클릭하면 열고, 휠 클릭하면 백그라운드로 연다. `⋮` 메뉴에는 하나 열기, 백그라운드 열기, 완료, 미확인, 메모/태그, 휴지통(휴지통 탭에서는 복원)이 있다.
  - 옛 사이드패널에는 항목별 메뉴가 없었다. 이번에 새로 넣었다.
- "선택" 버튼을 누르면 체크박스가 나타난다. "이 쪽 전체" 선택, 한꺼번에 완료·미확인·휴지통·복원을 할 수 있다. 휴지통 탭에는 휴지통 비우기가 있다.
- 브라우저 `confirm()`·`prompt()`는 UModal 확인창으로 바꿨다.
  - 탭 닫기는 옛 화면과 같이 "닫기 N"을 정확히 입력해야 버튼이 켜지고, 입력값 그대로 `close`에 보낸다.
  - 영구 삭제는 빨간 버튼으로 표시한다.
- 아래 고정 문구 대신 UToast 알림을 쓴다.
- 테마 버튼은 숨겼다(항상 어둡게). 저장된 테마 설정은 그대로 남아 있다.
- 탭 닫기 흐름(① 백업 → ② 검증 → ③ "닫기 N" 입력 후 닫기)과 안전 규칙은 백그라운드가 그대로 검사한다.
- 확인한 것: 테스트 53개 통과, 380px 폭 가짜 데이터 미리보기에서 화면 모양 확인
- 확인하지 않은 것: 실제 LibreWolf에서 동작, 닫기·가져오기 흐름

**1.13.0.3 관리 화면**
- 사이드패널 코드를 `ui/src/VaultPanel.vue` 하나로 옮겼다. `ui/src/sidebar/App.vue`와 `ui/src/manager/App.vue`는 이것을 `layout`만 다르게 불러 쓴다. 기능을 고칠 때는 이 파일 하나만 고치면 된다.
- 관리 화면 구성
  - 머리줄: 탭 보관함, 미완료 개수, supjav 수집 목록 버튼
  - 작업 시작 스위치와 연동 상태 칩
  - **탭 5개**: 보관함 · 열린 탭 보관 · supjav · 백업 · 연동. 마지막으로 연 탭은 localStorage `manager-section`에 기억한다.
- 탭별 내용
  - 보관함: 개수 카드 5개(전체, 미확인, 확인 중, 완료, 휴지통)와 사이드패널과 같은 목록, 쪽 이동
  - 열린 탭 보관: 저장 범위, 보관 버튼, 백업·검증·닫기 단계. 보관하면 자동으로 이 탭으로 바뀌고 단계 칸이 펼쳐진다. 관리 화면에서 닫을 때는 옛 화면처럼 guardWindowId를 보내지 않는다.
  - supjav: 수집 범위 설정과 안내. 실제 수집은 목록 탭에서 사이드패널 수집 버튼으로 시작한다.
  - 백업: JSON, TXT, HTML 내보내기, 가져오기, 컨테이너 권한
  - 연동: 옛 04 기능(서버 주소, PC 이름, 연동 켜기, 다시 받기, 끄기, 상태 문구)과 LibreWolf 안내
- 테스트 1개(닫기 보호 탭 주소)를 `ui/manager.html`로 고쳤다. 동작은 바뀌지 않았다.
- 참고: Nuxt UI 탭은 마우스를 누르는 순간(pointerdown/mousedown)에 바뀐다. 자동화 스크립트에서 `.click()`만 보내면 바뀌지 않는다. 실제 클릭은 정상이다.
- 확인한 것: 테스트 53개 통과, 1100px 가짜 데이터 미리보기에서 탭 5개 전환과 내용 확인
- 확인하지 않은 것: 실제 LibreWolf에서 동작

**1.13.0 정리(4단계)**
- 옛 화면 파일을 지웠다: `sidebar.html`, `manager.html`, `manager.js`, `view.js`, `sidebar.css`, `manager.css`, `controls.css`. 확장 폴더에는 백그라운드 코드와 `ui/`만 남는다.
- 옛 HTML 구조를 확인하던 테스트를 지웠다: `tests/controls.test.js`, 사이드패널 범위 칸 테스트, compact 행 테스트, 2,000개 DOM 렌더 부분. 2,000개 검색·정렬·쪽 나누기 검사는 남겼다.
- 대신 `ui/tests/screens.test.mjs`를 새로 만들었다(6개).
  - 진짜 `VaultPanel.vue`와 수집 목록 `App.vue`를 jsdom에서 띄우고, Nuxt UI 부품은 간단한 대역 부품으로 바꿔서 실행한다.
  - 사이드패널: 개수 표시, 작업 시작이 `setAutoSync`를 보내는지, 열린 탭 보관이 `capture`를 `{scope, windowId, dedupe:true}`로 보내는지, 백업 검증 전에는 닫기가 막혀 있는지
  - 휴지통 비우기는 확인창을 통과해야만 `emptyTrash`를 보내고, 취소하면 보내지 않는지
  - 항목 메뉴와 한꺼번에 처리하기
  - 관리 화면: 탭 5개가 있는지, 연동 탭에서 잘못된 주소는 보내지 않는지, 권한을 포트 없는 패턴으로 요청하는지
  - 수집 목록: 개수 탭과 완료 버튼
  - 새 화면 코드에 `confirm`·`prompt`·`v-html`이 없는지
  - 컴파일 결과는 `ui/.test-build/`에 생긴다(.gitignore). jsdom이 프로세스를 붙잡고 있어서 `--test-force-exit`로 끝낸다.
- `ui/src/rpc.ts`의 `ext`는 실행할 때마다 `browser`를 읽는다(테스트에서 가짜 browser로 바꿀 수 있게). 실제 확장에서는 동작이 같다.
- 확인한 것: 동작 테스트 49개와 화면 테스트 6개 통과, 빌드 통과
- 확인하지 않은 것: 실제 LibreWolf에서 1.13.0 최종판

**다음에 할 수 있는 것**: 밝은 테마(html 클래스 전환과 테마 버튼 다시 넣기), 수집 목록 화면 기능 추가 계획은 `docs/ui-redesign-plan.md`에 있다.
- 1.13.1.1: 수집 목록 그리드/목록 전환(localStorage collector-layout). 서버 supjav 목록 기준을 확장과 같게(태그 supjav 또는 주소 https://supjav.com/) 맞춤(서버 0.5.9-test2).
- 1.13.1.2: 수집 목록 화면(ui/collector.html) 삭제. 수집 진행·결과는 사이드패널/관리 화면 supjav 탭에서 봄. 보관함 목록에 출처 필터(전체/supjav). 서버 쪽 WEBUI 메뉴는 TAPS(/api/taps/*, 보관함 전체)로 변경(서버 0.5.9-test3).
- 1.13.1.3: 관리 화면 보관함 목록/그리드 전환(manager-layout), ⋮ 메뉴 '상세 보기'(썸네일·수집/포스트 날짜 등, 사이드패널 포함).
- 1.13.1.4: 수집 글을 날짜·번호로 재정렬하지 않고, 이번 수집에서 읽은 순서(좌상단→우하단→다음 쪽)를 거꾸로 넣음 → 최신순 목록이 supjav 화면 순서와 같음. 위치(쪽·칸)는 저장하지 않음(새 글이 올라오면 밀리므로).
- 1.13.1.5: 사이드패널 수집 버튼을 supjav 칸으로 옮기고 범위 설정 접기/펴기(supjav-settings-open). 관리 화면은 항상 펼침.
- 1.13.1.6: 수집/중지 한 버튼(중지는 빨강), 결과 문구도 접힘(수집 중에는 표시).
- 1.13.1.7: 목록 줄에 supjav 포스트 날짜 표시.
- 1.13.1.8: 서버 연결 배지 머리글로, 사이드패널 작업 시작 설명 제거.
- 1.14.0.1: 열린 탭 보관 자동 닫기(로컬 저장·검증 → 확인창(설정) → closeJob). 서버에는 flush로 바로 올리지만 기다리지 않음, 반영 결과는 sync-log에 기록(관리 화면 연동 탭에서 보기). 수집과 탭 보관은 background busy 잠금으로 동시 실행 불가. 저장 제외: 비 http(s), supjav 목록, 로딩 중 탭. 옛 백업 검증·닫기 N 흐름 삭제. 자세한 설계는 docs/auto-close-plan.md.
- 1.14.0.2: 관리 화면 '정리' 버튼 — 이미 보관함(휴지통 제외)에 있는 열린 탭만 DB 재확인 후 닫음. 새 저장 없음. 닫기 규칙은 열린 탭 보관과 공통(closeSources).
- 1.14.0.3: 연동 켜기=서버 모드, 끄기=로컬 모드. 로컬 모드도 변경을 outbox에 기록(서버 주소를 한 번 넣은 뒤부터)하고, 다시 켜면 그 변경을 먼저 올린 뒤 서버 변경을 받음. 배지 '로컬 모드 · n'.

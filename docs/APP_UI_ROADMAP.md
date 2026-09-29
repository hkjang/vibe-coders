# 차세대 관리자 콘솔 (`/app`) 로드맵

`/app`은 기존 `/admin`을 대체하지 않는 React 기반 차세대 관리자 콘솔이다. 두 UI는 같은 Go 서버, 인증, 권한, 데이터베이스, 관리 API를 사용한다. 신규 UI에 문제가 생기면 운영자는 언제든 `/admin`으로 복귀할 수 있다.

## 운영 원칙

- `/admin`은 Legacy Stable Console로 계속 제공하며 자동으로 `/app`으로 보내지 않는다.
- `/app`은 기본 비활성 상태로 배포한다. `ui.app.enabled=true`인 환경에서만 내장 React 빌드를 제공한다.
- `/app`이 비활성이거나 빌드가 누락되면 외부 자산 없는 안내 화면과 `/admin` 링크를 제공한다.
- 기능은 `Hidden → Legacy → Preview Read Only → Preview → Stable → Deprecated → Retired` 순으로 승격한다.
- 인증·RBAC·업무 로직을 UI별로 이중 구현하지 않는다.
- 운영 컨테이너에는 Node.js나 `node_modules`가 없고, Vite 산출물은 Go 바이너리에 포함된다.
- Service Worker, 외부 CDN, 외부 폰트, 런타임 외부 JavaScript를 사용하지 않는다.

## URL 계약

| 요청 | 서버 동작 |
| --- | --- |
| `GET /app` | 민감정보의 URL 잔존을 막기 위해 query를 폐기하고 `/app/`으로 308 이동 |
| `GET /app/` | 활성 시 React `index.html`, 비활성 시 안내 화면 |
| `GET /app/<client-route>` | 실제 파일이 없고 확장자가 없으면 SPA index |
| `GET /app/assets/<hash>.*` | 실제 파일만 제공, 1년 `immutable` 캐시 |
| 존재하지 않는 asset 또는 확장자 경로 | 404; SPA index로 fallback하지 않음 |
| `HEAD /app/*` | GET과 같은 상태·헤더, 본문 없음 |
| GET/HEAD 이외 `/app/*` | 405 및 `Allow: GET, HEAD` |
| `/admin`, `/auth`, `/v1`, `/mcp`, 운영 probe | 기존 핸들러가 계속 처리 |

`index.html`과 안내 화면은 항상 `Cache-Control: no-cache`이며 `/app`에만 별도 CSP와 보안 헤더를 적용한다. inline script/style을 사용하는 기존 `/admin`에는 이 CSP를 전역 적용하지 않는다.

## 활성화와 즉시 복구

기본값은 다음과 같다.

| 설정 | 기본값 |
| --- | --- |
| `ui.app.enabled` | `false` |
| `ui.app.default_entry` | `/app/overview` |
| `ui.app.legacy_fallback` | `true` |
| `ui.app.feedback_enabled` | `false` |
| `ui.app.telemetry_enabled` | `false` |

기존 `/admin`의 Runtime Settings에서 값을 변경할 수 있다. 컨테이너 최초 설정은 각각 `UI_APP_ENABLED`, `UI_APP_DEFAULT_ENTRY`, `UI_APP_LEGACY_FALLBACK`, `UI_APP_FEEDBACK_ENABLED`, `UI_APP_TELEMETRY_ENABLED` 환경변수로 제공할 수 있으며 DB override가 우선한다.

장애 시 `ui.app.enabled=false`로 전환한다. 각 pod는 기존 runtime setting reload 주기에 따라 반영하며 `/admin`과 API 트래픽은 영향을 받지 않는다.

## Bootstrap 계약

`GET /admin/ui-bootstrap`은 로그인 화면과 App Shell이 필요한 최소 정보를 집계한다.

- Backend/UI/API 버전
- `/app` 활성 상태와 기본 진입 경로
- 인증 모드, Keycloak 사용 여부, 로컬 로그인 허용 여부
- 유효한 credential이 있을 때만 현재 사용자·역할·scope
- 기능별 Migration Registry와 현재 사용 가능 판정
- 최소 시스템 상태와 Legacy route map

credential이 없는 응답은 공개 로그인 메타데이터만 포함한다. 유효하지 않은 credential은 401이며, 응답은 `no-store`다. 모든 응답에는 공통 `X-Request-ID`가 포함된다.

## 기능 전환 설정

각 registry 항목은 다음 override를 갖는다.

```text
ui.app.feature.<feature-id>.status
ui.app.feature.<feature-id>.roles
ui.app.feature.<feature-id>.rollout
ui.app.feature.<feature-id>.readonly
```

rollout bucket은 사용자 ID와 feature ID의 SHA-256 기반으로 계산하므로 새로고침이나 pod 변경 후에도 동일하다. Preview는 scope, 허용 역할, rollout을 모두 통과해야 한다. UI의 메뉴 숨김은 편의 기능일 뿐이며 모든 API는 기존 서버 권한 검사를 다시 수행한다.

`v0.84.0`에서 Legacy 콘솔의 모든 화면이 `/app`으로 이식되어 36개 기능 전체가 React 화면을 갖는다. 통합 현황, 게이트웨이 상태·공급자·모델·Chat 테스트, 라우팅, 요청·추적·세션·XView·LLM·프로브, 프롬프트 실험실과 라이브러리, 사용자·팀·내 홈, 거버넌스 정책·자동 조치·리포트·자산, MCP와 에이전트·워크플로·앱·Skill, Text2SQL, 데이터 웨어하우스·상품, 비용, 보안·Red Team·샌드박스, 시스템 상태·설정이 여기에 포함된다. 각 화면은 조회뿐 아니라 Legacy가 제공하던 생성·수정·삭제·실행·내보내기를 함께 제공하며, 통합 현황·요청 탐색기·추적 탐색기·시스템 상태는 성격상 읽기 전용으로 남는다. 서버 문서에 없어 호출할 수 없던 조작은 화면 안에 사유와 기존 화면 링크를 남겼고, 해당 API 문서를 바로잡았으므로 다음 단계에서 이식한다.

`v0.83.0` 추적 탐색기는 요청 단위 미리보기다. 시작 시각과 지연 구간, HTTP 상태, 모델, 안전 공급자 표시명, 토큰과 비용을 제공하며 세부 MCP·도구·Text2SQL 스팬 트리는 아직 Legacy 화면에 남겨 둔다. 해당 세부 기능은 팀 범위와 원문 제거가 보장되는 앱 전용 계약, 명시적 OpenAPI·Zod 스키마, 응답 행 상한을 갖춘 뒤 별도 단계에서 승격한다. 정확한 추적 ID 조회는 전용 복합 부분 인덱스로 지원하고 대용량 SQLite·PostgreSQL 계획 회귀로 검증한다.

공급자·모델 미리보기의 페이지 이동은 v0.82.0에서 서버 상한이 적용된 전체 응답을 사용하는 제한된 클라이언트 측 방식이다. `/admin/models`는 최대 20,000행·16MiB로 제한하지만 대규모 모델 목록의 화면 성능 목표는 아직 보장하지 않는다. 안정 기능으로 승격하기 전에는 커서 기반 서버 측 페이지 이동과 현재 페이지 범위의 품질·가격·태그 보강을 적용해야 한다. 운영에서 모델 응답이 1MiB를 넘거나 1,000행 이상이 상시 발생하거나 화면 API p95가 2초를 넘으면 미리보기 배포를 중지하고 페이지 이동 개선을 우선한다.

SQLite의 팀 범위 요청 조회는 전체 팀 이력을 먼저 정렬하지 않고 시간순 전역 커서를 따라가며 권한을 검사한다. 최신 구간에 해당 팀 요청이 매우 드문 환경에서는 더 오래 순회할 수 있으므로, 안정 기능 승격 전 빈 팀·희소 팀 성능 회귀를 추가하고 필요하면 최근 구간 탐색과 팀 인덱스 대체 경로를 결합한다.

1단계의 자동 갱신 기본값은 비활성이며 사용자가 1분 또는 5분을 선택할 수 있다. 대규모 보존 데이터에서도 자동 갱신을 기본 활성화하려면 `/admin/stats`와 장기간 라우팅 상태에 서버 집계·캐시를 추가하고 성능 회귀 기준을 먼저 통과해야 한다.

## 인증 안전성

- access/refresh token은 기존 호환을 위해 tab 단위 `sessionStorage`에만 저장한다.
- 여러 API가 동시에 401이어도 하나의 refresh promise만 실행하고 원 요청은 최대 한 번 재시도한다.
- 로그아웃 시 token과 Query cache를 지우고 `BroadcastChannel`로 다른 탭에 알린다.
- Keycloak `return_to`는 scheme/host/fragment가 없는 `/app/*` 또는 정확한 `/admin`만 허용한다.
- 검증한 `return_to`는 OIDC state와 함께 저장해 callback이 다른 pod에 도착해도 원래 화면으로 복귀한다.
- Keycloak 그룹은 팀 ID 또는 대소문자를 무시한 팀 이름으로 DB에서 직접 해석하고 실제 표준 팀 ID로 멤버십을 저장한다. ID와 다른 팀 이름이 충돌하면 권한 혼동을 피하기 위해 로그인을 차단한다.
- SSO 사용자·외부 식별자·팀 멤버십은 한 트랜잭션으로 저장한다. 서명 검증된 동일 발급자·사용자 식별자의 동시 첫 로그인은 하나의 SSO 전용 계정으로 수렴한다.
- `email_verified`가 없는 이메일은 계정 탐색·연결·저장에 사용하지 않는다. 로컬 비밀번호 계정이나 특권 계정과 이메일이 겹치면 권한을 상속하지 않는 별도 SSO 전용 계정을 만든다.
- Keycloak 설정에서 로컬 로그인을 끄면 로그인 화면뿐 아니라 `/auth/login` API도 403으로 차단한다.
- API Key, password, client secret, prompt/response 원문은 local storage나 UI telemetry에 저장하지 않는다.

## 화면 구성 구조

`/app`의 모든 화면은 도메인별로 자기 자신을 등록한다. 라우터, URL 쿼리 허용 목록, 구현 여부 판정이
한 곳에서 갈라져 어긋나지 않도록 하나의 등록부를 공유한다.

| 파일 | 역할 |
| --- | --- |
| `web/src/features/<domain>/routes.ts` | 그 도메인이 소유한 화면을 `{ featureId, load, queryKeys }`로 선언 |
| `web/src/features/registry.ts` | 도메인 선언을 모아 라우터·쿼리 허용 목록·구현 여부에 공급 |
| `web/src/shared/api/domains/<domain>.ts` | 그 도메인이 호출하는 서버 엔드포인트와 응답 스키마 |
| `web/src/shared/api/endpoint-factory.ts` | OpenAPI 경로·메서드 타입에 묶인 엔드포인트 선언 도구 |
| `web/src/shared/api/loose.ts` | 응답 스키마가 문서화되지 않은 기존 API를 위한 관대한 zod 도구 |

`queryKeys`에 등록하지 않은 쿼리 매개변수는 라우트 가드가 제거한다. 화면이 URL에 남길 수 있는 값을
화면 자신이 선언하므로, 비밀정보나 프롬프트가 실린 매개변수가 새 화면과 함께 조용히 들어올 수 없다.

구현 여부는 코드가 결정한다. `registry.ts`가 모은 featureId 집합이 곧 이 빌드가 소유한 화면이며,
런타임 전환 설정이 아직 화면이 없는 기능을 승격하더라도 라우트는 기존 화면 연결로 남는다.

Legacy와 `/app`의 격차는 CI가 기계적으로 검사한다. `go run ./cmd/api-surface-audit`는 Legacy 콘솔이
호출하는 모든 `/admin` 엔드포인트가 `/app` 콘솔의 API 계층에도 선언되어 있는지 비교하고, 하나라도
빠지면 실패한다. 두 콘솔은 현재 격차 0이다.

이 검사는 두 가지를 지켜야 의미가 있다. 첫째, 비교 대상에서 `web/src/shared/api/generated`를 제외한다.
생성된 OpenAPI 타입은 화면이 호출하든 말든 문서화된 모든 경로를 나열하므로, 이를 포함하면 Legacy 콘솔을
`/app` 콘솔이 아니라 카탈로그와 비교하게 된다. 둘째, Legacy 콘솔의 문자열 이어붙이기
(`'/admin/requests/' + id + '/trace'`)를 하나의 엔드포인트로 접는다. 첫 문자열만 읽으면
`/admin/requests/` 에서 멈춰 그 아래 모든 하위 동작이 이식된 것으로 계산된다. 실제로 이 두 허점 때문에
요청 추적·운영 홈·지식 캐시를 포함한 화면 여러 개가 `/app`에 없는 채로 이 검사가 통과했고, v0.84.1
이후 격차 15건을 찾아 모두 이식했다.

검사는 어떤 화면의 어떤 버튼이 그 엔드포인트를 호출하는지까지 보장하지는 않지만, 새 기능이 Legacy
콘솔에만 추가되어 이식 격차가 조용히 다시 벌어지는 것은 막는다. 같은 명령이 CLI·SDK·OpenAPI·서버 라우트
계약도 함께 검사한다.

## 공통 UI 구성요소

도메인 화면은 같은 조각을 사용해 한 제품처럼 보이도록 한다.

- 페이지: `PageHeader`(상태·기존 화면 링크·액션), `SectionCard`, `StatCard`/`StatGrid`, `KeyValueList`, `Toolbar`
- 목록과 상세: `DataTable`, `Sheet`(사이드 패널), `Dialog`, `JsonBlock`, `CopyButton`
- 입력과 변경: `FormField`, `FormDialog`+`useZodForm`, `ConfirmDialog`(사유 입력), `Select`, `Textarea`, `Checkbox`, `Switch`
- 상태 전달: `LoadingState`, `ErrorState`(요청 ID 포함), `EmptyState`, `InlineNotice`
- 훅: `useSearchState`(URL 필터), `useTabParam`, `useRefreshInterval`, `useMutationFeedback`(토스트와 캐시 무효화)

`v0.86.0`부터 공통 `DataTable`은 화면이 안정적인 `tableId`를 지정한 경우에만 열 표시·순서·너비
맞춤 설정을 제공한다. 공급자와 모델 목록에서 먼저 활성화했으며 리소스 식별 열과 쓰기 작업 열은
숨길 수 없다. 열 설정은 허용된 열 ID, 순서, 표시 여부, 80~640px 범위의 너비만 브라우저에 저장한다.
요청 ID, 행 데이터, 필터, 페이지 커서, Prompt와 Secret은 저장 형식에 포함되지 않는다. 저장값은
현재 열 allowlist로 다시 검증하고 손상된 값, 사라진 열, 마지막 열을 숨기는 값은 폐기한다. 표가 실제로
가로로 넘칠 때만 이동 안내를 표시하고 로딩 중에는 머리글과 열 폭을 유지하는 skeleton 행을 사용한다.
마우스 드래그뿐 아니라 열 이동 버튼과 머리글 resize handle의 화살표·Home·End 키도 지원한다.
`tableId`가 없는 기존 사용처는 전과 같은 호출·레이아웃 계약을 유지한다.

화면 테스트는 `renderScreen`, `mockApi`, `testAuth` 헬퍼를 사용한다. `mockApi`는 등록되지 않은 API 호출을
실패로 처리하므로, 화면이 호출하는 서버 계약이 테스트에 빠짐없이 드러난다.

### 한글 표시와 전환 설정 저장

`v0.86.1`에서는 채팅 테스트·게이트웨이 MCP·스킬·레드팀 메뉴와 관련 작업 이름을 한글로 통일한다.
실제 메뉴는 서버 bootstrap의 제목을 사용하므로 서버와 React의 기본 전환 목록을 함께 맞춘다.
MCP 위험도·판단, 정책 조건·동작, Text2SQL 권한 주체·동작은 한글 표시 이름과 API 코드값을 분리한다.
알 수 없는 서버 코드나 사용자가 지은 리소스 이름을 임의의 정상 상태로 번역하지 않는다.

기능별 콘솔 전환 설정은 기존 `PUT /admin/settings/bulk`로 변경된 항목만 한 번에 저장한다.
각 항목에 조회 당시 버전을 보내고 DB override가 없으면 `expected_version=0`을 사용한다.
서버는 값·버전·설정 이력을 하나의 트랜잭션에서 반영하므로, 뒤 항목의 검증이나 버전 확인이 실패해도
앞 항목만 적용되는 상태를 만들지 않는다. 변경 사유는 기존 설정 이력에 함께 남는다.

- `409` 동시 수정 충돌: 입력 초안을 유지하고 재저장을 막는다. 최신 설정을 다시 조회한 뒤 편집창을
  다시 열어 변경을 검토한다.
- `503 setting_reload_pending`: DB에는 일괄 저장됐지만 런타임 반영이 대기 중임을 알린다.
  요청 ID와 함께 최신 설정을 확인하도록 안내하며 자동으로 같은 저장을 반복하지 않는다.
- 그 외 오류: 편집창과 입력을 유지하고 기존 공통 오류 처리와 서버 권한 검사를 사용한다.

이 개선은 `/app` 기본 활성화나 Stable 승격을 뜻하지 않는다. Phase 6의 기능별 사용·기존 화면 복귀
관측, 운영 기간의 안정성·성능 근거, 역할별 전체 업무 E2E 검증은 계속 남아 있다.

## 선택적 사용 관측 (`v0.86.2`)

`ui.app.telemetry_enabled`는 계속 기본 `false`다. 운영자가 명시적으로 켰을 때만 권한을 통과한
기능 진입과 해당 화면에서 기존 화면 링크를 연 방문을 같은 출처의 API로 관측한다.
`POST /admin/ui-telemetry/events`는 기능 ID, 방문마다 새로 만든 128비트 임시 ID, 두 종류의 이벤트만
받는다. 임시 ID는 메모리에만 있고 DB에는 SHA-256 해시만 남는다. 사용자·팀·역할·토큰·IP·User-Agent·
URL·검색어·Prompt·응답·SQL 결과를 이 집계에 넣지 않는다. 네트워크 인증·전송 자체에서 사용하는
Bearer와 IP를 없애는 기능은 아니며 기존 서버 인증·업무 감사 체계도 변경하지 않는다.

- 동일 방문의 재렌더·필터 변경·여러 클릭은 중복 집계하지 않는다. 클릭이 먼저 도착해도 하나의
  방문과 하나의 이동으로 저장한다. 비율은 ‘관측된 방문 중 기존 화면 링크를 연 방문’이며 순사용자,
  전체 채택률 또는 기존 화면 도착 성공률이 아니다.
- 수집 요청마다 현재 DB의 활성화·수집 설정과 기존 기능 권한·역할·점진 배포·이동 허용을 확인한다.
  수집을 끄기 전에 수락한 진행 중 요청은 끝날 수 있다. 취소 예산은 2초이며 드라이버 취소·정리
  지연까지 포함한 엄격한 응답 시간 보장은 아니다. 실패는 버리며 자동 재시도·영구 큐를 두지 않는다.
- 본문은 1KiB, 동시 처리는 프로세스당 4개, 수신은 초당 20개(순간 최대 40개)로 제한한다.
  인증을 통과한 호출자도 프로세스별 UTC 일자당 최대 600개 이벤트로 제한한다. 호출자 원본 ID 대신
  프로세스·날짜별 무작위 키로 만든 HMAC만 메모리에 두며 집계 DB·로그에 기록하지 않는다.
  메모리의 호출자 슬롯은 4,096개로 제한하고 가득 차면 기존 한도를 초기화하지 않고 새 호출자의
  이벤트를 버린다. 공유 관리자 자격은 같은 한도를 쓰며, 여러 파드의 합산 한도나 재시작을 넘는
  영속 한도가 아니다. 빠른 단일 호출자 용량 독점을 완화할 뿐 클라이언트가 신고하는 집계의
  진실성을 보증하거나 모든 서비스 거부 공격을 차단하지는 않는다.
  DB는 최대 10만 방문, 집계는 최근 30일로 제한한다. 만료 기록은 새 수집 트랜잭션·서버 시작·
  매시간 정리하며, 일반 retention이나 수집을 꺼도 정리 루프는 작동한다. DB 오류로 실패한
  정리는 다음 주기에 다시 시도하므로 실제 삭제 시각에는 지연이 있을 수 있다.
- SQLite 관측 트랜잭션은 전용으로 빌린 연결의 잠금 대기를 50ms로 제한하고 원래 값을 복원한다.
  복원에 실패한 연결은 풀로 돌려보내지 않는다. 전역 DB 잠금 정책이나 기존 업무 동작은 바꾸지 않는다.
- `GET /admin/ui-telemetry/summary?days=7|30`은 관리자 조회 권한으로 현재 접근할 수 있는 기능의
  집계만 반환한다. 원본 방문 ID/해시·개별 시각은 반환하지 않는다. **시스템 설정 → 콘솔 전환**에서
  수집 상태·기간·방문·이동·비율을 확인하며 기간은 URL에 유지한다.
- 좁은 화면에서는 사용 관측과 전환 설정 표 각각의 내부에서 가로 스크롤한다. 조회 버튼은
  갱신 중에도 키보드 포커스를 유지하며 중복 활성화를 무시한다. 제목 단계를 유지하고,
  390px 브라우저에서 문서 가로 넘침·기간 변경·키보드 갱신을 검증한다.
- 로그인·최상위 오류 화면, 계측되지 않은 브라우저 컨텍스트 메뉴 동작, 전송 실패와 상한 초과는
  관측에서 빠질 수 있다. 이 수치로 자동 Stable 승격하지 않는다. 별도의 업무·역할·안정성·성능
  근거가 필요하다. 기존 `tracking.*` 외부 방문 추적과 연결하거나 자동 활성화하지 않는다.

로그아웃·다른 탭 로그아웃·계정 교체 뒤 이전 인증 조회나 SSO 교환 응답이 늦게 도착해도 이전
인증·수집 상태를 복원하지 않는다. 수집 설정을 확인할 수 없을 때는 마지막 정상 탐색 상태와 달리
수집만 닫힌 상태로 처리한다.

## 빌드와 배포

### 검색과 키보드 탐색 (`v0.86.3`)

명령 팔레트는 한글 조합 입력 중 확인·후보 이동·취소 키를 명령으로 실행하지 않는다.
메뉴명·그룹·별칭을 여러 단어로 검색할 수 있으며 NFC로 한글 조합 형태를 맞춘다.
요청·추적·세션 ID 바로가기는 현재 권한으로 React 요청 탐색기를 열 수 있을 때만 제공한다.
기존 화면 전용 상태에는 React 필터를 넘길 수 없으므로 해당 바로가기를 숨긴다.
검색 결과가 없으면 안내와 초기화 버튼을 제공하고 live 영역에는 원문 대신 개수만 알린다.
닫기·도움말 연쇄 이동은 원래 요소로, 화면 이동은 본문으로 포커스를 복원한다.
낮고 좁은 화면에서도 검색·닫기는 유지하고 목록이나 도움말 본문만 스크롤한다.
검색어를 새로 영속 저장·전송하지 않으며 Route Guard와 서버 권한 검사를 대체하지 않는다.

### 빌드 성능 예산 (`v0.86.3`)

`pnpm build`는 Vite 빌드 뒤 성능 검사를 실행한다. 단순히 가장 큰 JS 파일 하나를 비교하지 않고,
Vite manifest와 실제 HTML·CSS 참조를 따라 동일 파일을 한 번만 합산한다. 숫자는 1KB = 1,000B 기준이다.

- **초기 빌드 에셋: 350,000B 이하.** HTML·정적 JS 의존성·스타일·참조 폰트와 이미지의 전송 크기
  참고값을 합산한다. Go가 압축하는 확장자는 파일마다 gzip level 9와 원본 중 작은 값을 쓰고,
  이미 압축된 폰트·이미지 등 나머지는 원본 크기로 계산한다. Go 서버 소유 `/favicon.ico`는
  프론트엔드 산출물이 아니므로 보고서의 제외 항목에 명시한다.
- **화면별 추가 에셋: 원본 250,000B 이하.** 각 지연 로딩 진입점에서 초기 캐시를 제외한 정적 의존성과
  하위 동적 의존성·CSS·에셋을 합산한다. 선택적으로 여는 하위 화면도 보수적으로 포함한다.
  초기 공통 파일은 의존성 순회 자체를 중단해 다른 화면 전체를 잘못 합산하지 않는다.
- manifest·진입점·정적으로 확인한 참조 파일 누락, 리터럴 외부 URL·출력 디렉터리 탈출, 예산 초과는 빌드를 실패시킨다.
  따라서 동일한 `pnpm build`를 쓰는 CI와 Docker 릴리즈 빌드도 실패한다. 환경변수나 CLI로 상한을
  완화하지 않으며, 변경하려면 검사 코드·테스트·문서를 함께 검토한다.
- `web/bundle-budget-report.json`은 재생성 가능한 검사 결과이며 Git과 Docker 컨텍스트에서 제외한다.
  CI는 성공·실패 여부와 별개로 생성된 보고서를 14일 보관한다. `pnpm bundle:check`로 기존 빌드를
  재검사할 수 있다. `.vite/manifest.json`은 빌드용이며 `/app`의 숨김 경로 차단 대상이다.
- 출력 JS의 정적 import·export, 문자열 리터럴 동적 import와 `new URL(..., import.meta.url)`도 검사한다.
  실행 중 계산하는 참조는 정적으로 확정할 수 없으므로 `unresolvedRuntimeReferences`에 파일·종류·건수만
  보고하고 측정에서 제외한다. React Router·Vite의 런타임 helper도 이 범주에 들어가며 코드나 URL 값은
  보고서에 넣지 않는다. 따라서 이 검사는 모든 런타임 네트워크 요청의 오프라인 적합성을 보증하지 않는다.

이 검사는 재현 가능한 빌드 용량 예산이다. Node gzip과 Go의 실제 압축 결과에는 차이가 있을 수 있고,
API 응답·HTTP 헤더·네트워크·기기 성능을 측정하지 않는다. 2초 사용 가능·300ms 화면 이동·Lighthouse
점수와 운영 Stable 승격에는 별도 실행 환경의 측정 근거가 필요하다.

프로덕션 이미지는 세 단계로 만든다.

1. Node 24 builder가 고정된 pnpm lockfile로 `web/dist`를 생성한다.
2. Go 1.26.8 builder가 해당 산출물을 `internal/appui/dist`에 복사하고 바이너리에 embed한다.
3. Distroless nonroot 런타임에는 단일 gateway 바이너리와 쓰기 가능한 `/data`만 남긴다.

동일한 release version을 `VITE_UI_VERSION`과 `proxy.AppVersion`에 주입한다. frontend build, 비어 있는 index, asset 누락 중 하나라도 발생하면 release build는 실패한다.

## 단계별 상태

| Phase | 범위 | 현재 상태 |
| --- | --- | --- |
| 0 | route/embed, App Shell, API client, auth/RBAC, registry, Legacy Bridge, CI | 완료 (`v0.80.0`) |
| 1 | 현황, 상태, 요청·추적·세션, 사용량·비용, 공급자·모델 조회 | 완료 (`v0.84.0`) |
| 2 | Provider/Model Tag/Alert/Saved Filter 등 저위험 변경 | 완료 (`v0.84.0`) |
| 3 | 사용자·팀·API Key·Quota·MCP·App·Workflow·Skill | 완료 (`v0.84.0`) |
| 4 | Routing·Policy·Settings·Text2SQL·DW retry | 완료 (`v0.84.0`) |
| 5 | Kill Switch·Secret Rotation·Bulk Import 등 Critical 작업 | 완료 (`v0.84.0`, Bulk Import는 별도 설계) |
| 6 | `/app` 기본화와 기능별 Legacy deprecation 검토 | 진행 중 (기본 비활성 사용 관측 추가, 운영 근거와 정식 승격은 미완료) |

화면 이식이 끝났다고 Stable 승격이 끝난 것은 아니다. 각 기능은 데이터 정합성, 권한, URL 복원, 상태 UI, 접근성, 성능, 변경 안전성, 감사, E2E, Legacy fallback을 모두 통과한 뒤에만 Stable로 승격한다.

## 검증 명령

```bash
cd web
corepack pnpm install --frozen-lockfile
corepack pnpm check

cd ..
go test ./...
go vet ./...

docker build --build-arg VERSION=dev-appui -t vibe-coders:appui .
bash scripts/container-smoke.sh vibe-coders:appui dev-appui
```

컨테이너 smoke test는 `/admin` 회귀, `/app` 308, deep link, hashed asset 캐시, 누락 asset 404, 잘못된 method 405, nonroot 실행, Backend/UI version 일치를 함께 확인한다.

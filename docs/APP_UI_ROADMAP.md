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

## 공통 UI 구성요소

도메인 화면은 같은 조각을 사용해 한 제품처럼 보이도록 한다.

- 페이지: `PageHeader`(상태·기존 화면 링크·액션), `SectionCard`, `StatCard`/`StatGrid`, `KeyValueList`, `Toolbar`
- 목록과 상세: `DataTable`, `Sheet`(사이드 패널), `Dialog`, `JsonBlock`, `CopyButton`
- 입력과 변경: `FormField`, `FormDialog`+`useZodForm`, `ConfirmDialog`(사유 입력), `Select`, `Textarea`, `Checkbox`, `Switch`
- 상태 전달: `LoadingState`, `ErrorState`(요청 ID 포함), `EmptyState`, `InlineNotice`
- 훅: `useSearchState`(URL 필터), `useTabParam`, `useRefreshInterval`, `useMutationFeedback`(토스트와 캐시 무효화)

화면 테스트는 `renderScreen`, `mockApi`, `testAuth` 헬퍼를 사용한다. `mockApi`는 등록되지 않은 API 호출을
실패로 처리하므로, 화면이 호출하는 서버 계약이 테스트에 빠짐없이 드러난다.

## 빌드와 배포

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
| 6 | `/app` 기본화와 기능별 Legacy deprecation 검토 | 대기 |

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

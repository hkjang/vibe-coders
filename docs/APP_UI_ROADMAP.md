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

현재 React 제공 기능은 `overview`, `gateway.health`, `system.health`, `gateway.providers`, `gateway.models`, `observability.requests`, `observability.traces`의 읽기 전용 미리보기다. 공급자·모델 조회는 `/admin/providers`, `/admin/models`와 기존 품질·가격·태그 API를 공통으로 사용한다. 요청 탐색기는 기존 `/admin/requests`를 공동 사용하되 `X-Vibe-UI: app` 요청에만 프롬프트·응답·원시 오류를 제외한 안전한 메타데이터 투영과 필터에 결합된 암호화·서명 양방향 커서를 제공한다. 추적 탐색기의 첫 단계도 같은 안전 투영을 재사용해 동일한 `trace_id`에 속한 요청만 시간축과 표로 비교하며, 원시 오류·Text2SQL 거절 사유가 포함될 수 있는 기존 상세 추적 API는 호출하지 않는다. 기존 시각 데이터를 재작성하지 않고 SQLite·PostgreSQL 공통 정규화 표현식 인덱스로 정확한 시간 순서를 유지하며, 최대 201개의 부모 요청을 먼저 확정한 뒤 해당 요청의 최신 사용량·응답만 조회한다. 각 화면은 로딩·부분 실패·마지막 정상 데이터·요청 ID·재시도·기존 화면 연결을 제공한다. 공급자·모델 변경과 세션을 포함한 나머지 관측, 라우팅, 거버넌스, MCP, Text2SQL, 비용, 보안, 설정 기능은 기존 화면 연결을 유지한다.

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
| 1 | 현황, 상태, 요청·추적·세션, 사용량·비용, 공급자·모델 조회 | 진행 중 (`v0.83.0`: 통합 현황·게이트웨이 상태·시스템 상태·공급자·모델·요청 탐색기·요청 단위 추적 탐색기 읽기 전용 미리보기) |
| 2 | Provider/Model Tag/Alert/Saved Filter 등 저위험 변경 | 대기 |
| 3 | 사용자·팀·API Key·Quota·MCP·App·Workflow·Skill | 대기 |
| 4 | Routing·Policy·Settings·Text2SQL·DW retry | 대기 |
| 5 | Kill Switch·Secret Rotation·Bulk Import 등 Critical 작업 | 대기 |
| 6 | `/app` 기본화와 기능별 Legacy deprecation 검토 | 대기 |

Phase 0 완료는 전체 프로젝트 완료를 의미하지 않는다. 각 기능은 데이터 정합성, 권한, URL 복원, 상태 UI, 접근성, 성능, 변경 안전성, 감사, E2E, Legacy fallback을 모두 통과한 뒤에만 Stable로 승격한다.

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

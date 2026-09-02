# Next Admin Console (`/app`) roadmap

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
| `GET /app` | query를 보존해 `/app/`으로 308 이동 |
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

초기 React 제공 기능은 `overview`의 읽기 전용 Preview뿐이다. Provider, Model, Routing, Observability, Governance, MCP, Text2SQL, FinOps, Security, System은 Legacy Bridge로 시작한다.

## 인증 안전성

- access/refresh token은 기존 호환을 위해 tab 단위 `sessionStorage`에만 저장한다.
- 여러 API가 동시에 401이어도 하나의 refresh promise만 실행하고 원 요청은 최대 한 번 재시도한다.
- 로그아웃 시 token과 Query cache를 지우고 `BroadcastChannel`로 다른 탭에 알린다.
- Keycloak `return_to`는 scheme/host/fragment가 없는 `/app/*` 또는 정확한 `/admin`만 허용한다.
- 검증한 `return_to`는 OIDC state와 함께 저장해 callback이 다른 pod에 도착해도 원래 화면으로 복귀한다.
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
| 1 | Overview, health, request/trace/session, usage/cost, provider/model 조회 | 다음 단계 |
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

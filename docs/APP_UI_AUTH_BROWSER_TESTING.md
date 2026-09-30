# 실제 인증 브라우저 검증

이 검증은 React 콘솔을 **실제 Go HTTP 서버, 임시 SQLite, 로컬 OIDC 공급자**에 연결한다. 일반 `web/tests/e2e`의 API fixture 검증과 별도 실행 경로이며, 운영 계정·운영 DB·외부 IdP를 사용하지 않는다. 제품 인증 우회나 테스트 전용 제품 API를 추가하지 않고 `Server.Routes()`를 그대로 실행한다.

## 검증 구성과 범위

- Go 하네스: `internal/proxy/auth_browser_integration_test.go`
- 테스트용 OIDC 공급자: `internal/proxy/oidc_browser_fixture_test.go`
- 브라우저 설정과 시나리오: `web/playwright.auth.config.ts`, `web/tests/auth-live/auth-live.spec.ts`
- 안전 보고서: `web/tests/auth-live/safe-reporter.ts`
- 보고서 누출 방지 회귀: `web/scripts/auth-report-sanitization.test.mjs`

게이트웨이와 IdP는 임의의 loopback 포트에서 실행한다. 임시 DB에는 합성 관리자·읽기 전용 관리자·팀을 만들고, 비밀번호·JWT 서명 비밀·IdP 클라이언트 비밀은 실행마다 생성한다. IdP는 실제 HTTP discovery/JWKS/인증 코드/토큰 엔드포인트와 RSA 서명 ID 토큰을 제공하는 **테스트용 구현**이지 Keycloak 제품 인스턴스는 아니다.

React 화면은 Vite 개발 서버가 아니라 Go 바이너리에 포함된 정적 배포 파일을 사용한다. 따라서 **웹 빌드 → `internal/appui/dist` 복사 → Go 컴파일** 순서를 지켜야 한다. Go 컴파일 이후 웹 파일만 바꾸어도 이미 컴파일된 화면은 바뀌지 않는다.

| 시나리오        | 실제로 확인하는 내용                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH-LIVE-001` | 잘못된 비밀번호의 401, 정상 로그인, 공급자 딥 링크와 새로고침, 관리자/읽기 전용 관리자 화면 차이, 실제 읽기 허용과 쓰기 거부, 로그아웃 후 브라우저 자격 증명 제거 |
| `AUTH-LIVE-002` | 로컬 IdP 로그인부터 Go 콜백·내부 세션 교환까지의 흐름, 원래 경로와 query 복귀, 교환 fragment 제거, 소비된 일회 교환 코드 재사용 거부, 외부 `return_to` 거부       |
| `AUTH-LIVE-003` | 실제 access token 만료 후 복수 관리 API의 401, refresh 시도 1회와 성공 응답 1회, 인증 유지, 이전 refresh token 재사용 거부                                        |
| `AUTH-LIVE-004` | 다른 탭 로그아웃 전파와 양 탭 자격 증명 제거, 로그아웃한 세션의 refresh 거부, 같은 문서에서 새 계정 로그인 후 이전 관리자 bootstrap 응답이 권한을 되살리지 않음   |
| `AUTH-LIVE-005` | 실제 서버에서 세션을 폐기한 뒤 갱신 요청 1회의 401, 로그인 화면 복귀와 브라우저 자격 증명 제거, 재로그인 후 원래 공급자 화면 복귀                                 |

다음 세부 조건도 증명 범위를 해석할 때 중요하다.

- access token TTL은 하네스에서 **8초**이다. 003은 서버의 실제 시계로 만료되도록 TTL보다 1초 더 기다린다. 브라우저 시계를 바꾸어 JWT 만료를 흉내 내지 않는다. 자동 새로고침을 끈 뒤 명시적 조회로 복수 401, refresh 요청 시도 1회와 성공 응답 1회를 각각 관찰한다. 성공 응답만 세어 실패한 중복 갱신 시도를 놓치지 않도록 구분한다.
- 002의 재사용 검사는 같은 합성 교환의 브라우저 바인딩 쿠키를 복원한 뒤 실행한다. 쿠키가 없어서 생긴 401을 서버의 일회 코드 소비 검증으로 오인하지 않기 위한 조치다. API 응답이나 새 인증 토큰을 만들어 넣지 않는다.
- 004만 `route.fetch()`로 받은 실제 `200/admin` bootstrap 응답 한 건을 보류한 뒤 `route.fulfill({ response })`로 그대로 전달한다. 본문·상태를 합성하거나 바꾸는 API mock이 아니다. 새 계정으로 로그인할 때 문서를 새로 로드하지 않으므로, 단순 페이지 종료로 이전 요청을 없앤 테스트도 아니다.
- 005는 기존 서버 로그아웃 API로 세션을 폐기하지만 UI 로그아웃을 호출하거나 브라우저 토큰을 지우지 않는다. 실제 만료 후 화면 갱신이 서버의 refresh 거부를 발견하고 로그인으로 복귀해야 한다. 로그인 화면을 직접 열거나 401 응답을 합성하지 않는다.
- 읽기 전용 관리자의 공급자 쓰기 거부는 기존 서버 계약인 **401**을 확인한다. 이 테스트를 맞추기 위해 제품 응답을 403으로 바꾸지 않는다.
- 하네스는 SSO가 활성화되어 있어 로컬 로그인 뒤의 로그아웃도 `/auth/keycloak/logout`을 사용한다. 이 검증으로 `/auth/logout`의 모든 경로를 브라우저에서 검증했다고 주장하지 않는다.

## 준비와 정적 애셋 포함

아래 예시는 Linux x86-64의 **검증용 checkout 루트**에서 실행한다. 다른 작업의 배포 파일과 섞이지 않도록 별도 checkout을 권장한다. 경로는 현재 사용자가 선택한 checkout에서 계산하며, 특정 임시 worktree 경로를 가정하지 않는다.

필요한 도구는 `go.mod`의 Go 버전, `web/.node-version`의 Node, `web/package.json`의 pnpm 버전과 Docker다. 현재 고정값은 Go 1.26.8, Node 24.20.0, pnpm 11.25.0이다. 아래 이미지와 의존성을 처음 준비하는 단계에는 네트워크가 필요할 수 있다. **오프라인 실행 전 도구·Go 모듈·패키지·이미지 캐시를 미리 준비**해야 한다.

```sh
set -eu
AUTH_CHECKOUT="$(pwd -P)"
AUTH_VERIFICATION="$(mktemp -d /tmp/vibe-auth-browser.XXXXXX)"
AUTH_REPORTS="$(mktemp -d /tmp/vibe-auth-reports.XXXXXX)"
AUTH_IMAGE='mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e'

test -f "$AUTH_CHECKOUT/go.mod"
test -f "$AUTH_CHECKOUT/web/playwright.auth.config.ts"
docker pull "$AUTH_IMAGE"

(
  cd "$AUTH_CHECKOUT/web"
  CI=1 corepack pnpm install --frozen-lockfile
  corepack pnpm build
)

mkdir -p "$AUTH_CHECKOUT/internal/appui/dist"
cp -R "$AUTH_CHECKOUT/web/dist/." "$AUTH_CHECKOUT/internal/appui/dist/"
```

`pnpm-lock.yaml`은 변경하지 않는다. `web/dist`와 embed staging은 생성물이다. 이미 실행 중인 다른 작업의 checkout에서 이 복사를 수행하지 않는다. 하네스는 포함된 `index.html`과 `/app/assets/` 파일이 없으면 개발 서버로 대체하지 않고 실패한다.

## 오프라인 컴파일과 고정 브라우저 실행

앞 단계에서 준비한 동일 checkout과 `AUTH_VERIFICATION`을 사용한다. 다음 컴파일은 이미 캐시된 Go 도구·모듈만 사용하도록 네트워크 조회를 끈다. 캐시가 부족하면 실패하므로, 운영 환경 설정을 가져오거나 임의 의존성으로 대체하지 않는다.

```sh
(
  cd "$AUTH_CHECKOUT"
  GOTOOLCHAIN=go1.26.8 GOPROXY=off GOSUMDB=off \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go test -c -o "$AUTH_VERIFICATION/auth-browser.test" ./internal/proxy
)

docker run --rm --init --ipc=host --platform linux/amd64 --network none \
  --mount "type=bind,source=$AUTH_CHECKOUT,target=/workspace,readonly" \
  --mount "type=bind,source=$AUTH_VERIFICATION,target=/verification,readonly" \
  --mount "type=bind,source=$AUTH_REPORTS,target=/workspace/web/test-results" \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --workdir /workspace \
  --env VIBE_AUTH_BROWSER_TEST=1 \
  --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  "$AUTH_IMAGE" \
  /verification/auth-browser.test \
    -test.run '^TestAuthBrowserIntegration$' -test.count=1 -test.timeout=6m -test.v
```

이 명령은 게이트웨이와 Chromium을 같은 컨테이너에서 실행하므로 호스트 포트를 공개할 필요가 없다. 컴파일 후 실행 자체에는 패키지 설치나 Go 다운로드가 없다. 하네스는 설치된 Playwright CLI를 `node`로 직접 실행한다. `pnpm exec`가 호스트/컨테이너 차이를 감지해 의존성을 자동 재설치하는 경로를 피한다.

위 예시의 **외부 네트워크 차단 + checkout·바이너리 디렉터리 읽기 전용** 조건에서 다섯 시나리오를 검증했다. 컨테이너 내부 loopback 통신은 계속 사용한다. 별도 전용 `AUTH_REPORTS`만 `/workspace/web/test-results`에 쓰기 가능하게 연결하며, DB·브라우저 임시 파일은 `/tmp` tmpfs를 사용한다. 컨테이너 루트 파일시스템 전체에 `--read-only`를 적용한 검증은 아니다. 브라우저 요청도 하네스의 정확한 게이트웨이·IdP origin 두 개만 허용하며, 다른 origin 요청을 발견하면 실패한다.

하네스가 자신의 checkout을 찾을 수 있도록 작업 디렉터리를 `/workspace`로 유지한다. `APP_BASE_URL`, 계정 정보, IdP 주소는 하네스가 생성해서 자식 프로세스에 전달한다. 사용자가 운영 주소나 비밀번호를 주입해 실행하는 방식은 지원하지 않는다. `VIBE_AUTH_BROWSER_TEST=1`이 없으면 실제 브라우저 통합 테스트는 명시적으로 건너뛴다.

실행이 끝나면 `AUTH_REPORTS`의 **안전 요약 파일만** 보관하고, 본인이 `mktemp -d`로 만든 `AUTH_VERIFICATION`과 `AUTH_REPORTS` 경로를 각각 확인하여 정리한다. 다른 checkout·공유 임시 디렉터리·사용자 홈을 재귀 삭제하지 않는다.

## 결과와 민감 정보 취급

보고서의 컨테이너 내부 경로는 `/workspace/web/test-results/auth-live-summary.json`이며, 위 명령으로 실행하면 호스트의 **`$AUTH_REPORTS/auth-live-summary.json`**에 생성된다. checkout의 기존 `web/test-results` 파일을 덮어쓰지 않는다. 직접 실행과 CI의 경로는 `web/test-results/auth-live-summary.json`이다. 전체 상태와 각 시나리오의 다음 항목만 기록한다.

- 정해진 형식의 `AUTH-LIVE-NNN` 식별자 또는 `UNKNOWN`
- 테스트 상태와 소요 시간
- 진단에 필요한 경우 테스트 소스의 행 번호만 (`lastSourceLine`, `failureSourceLine`)

테스트 제목 원문, 단계 설명, URL, 요청/응답 본문, 헤더, 오류 메시지·스택, 첨부 파일, 비밀번호·토큰은 보고서에 넣지 않는다. 자식 프로세스의 stdout/stderr도 버린다. trace·video·screenshot은 꺼져 있고 Playwright 출력 디렉터리는 보존하지 않도록 설정되어 있다. HAR나 storage-state 저장도 추가하지 않는다. 브라우저 프로필 등 임시 파일은 Go `t.TempDir()` 아래의 **0700 권한 `browser-tmp`**에 모으고 정상 종료 및 하네스가 처리하는 timeout 후 정리한다. 외부에서 전체 실행 환경을 강제 종료한 경우까지 정리를 보장한다는 뜻은 아니다.

Node 누출 방지 테스트는 실제 TypeScript reporter에 합성 비밀 마커를 주입해 JSON 허용 필드, 숫자 행 번호, stdout/stderr 비출력 및 추가 파일 부재를 확인한다. reporter 구현을 복제한 mock 테스트가 아니다.

```sh
(
  cd "$AUTH_CHECKOUT/web"
  node --test scripts/auth-report-sanitization.test.mjs
)
```

실패 진단은 Go 종료 상태와 안전 요약의 시나리오 ID·행 번호를 함께 확인한다. 단계 설명이나 전체 스택을 출력하도록 reporter를 바꾸어 진단하지 않는다. Playwright 실행 전 실패했다면 새 요약 파일이 없을 수 있다. 매 실행마다 새 `AUTH_REPORTS`를 만들고, 이전 실행의 요약을 이번 성공 근거로 삼지 않는다. 원문 인증 자료는 보관·업로드 대상이 아니다.

## CI와 남아 있는 검증

`.github/workflows/ci.yml`의 `auth-browser` job은 `frontend`의 정적 애셋 artifact를 받은 뒤 embed 경로에 배치하고, 고정 Playwright 이미지에서 frozen 의존성과 실제 Go 통합 테스트를 실행한다. worker 1개, retry 0회다. 전체 job 제한은 15분, Go 테스트 제한은 6분, 하네스 자식 실행 제한은 4분이다. 업로드 대상은 안전 요약 JSON 한 개뿐이며, 실패해도 인증 trace나 전체 `test-results` 디렉터리를 업로드하지 않는다.

이 검증은 다음을 대신하지 않는다.

- 실제 Keycloak 배포의 설정·버전·인증서 호환성 및 운영 계정 검증
- HTTPS·서로 다른 사이트 간 쿠키 정책과 RP-initiated IdP end-session 로그아웃
- 모든 탭이 따로 발급받은 서버 세션을 한 번에 취소하는 기능의 검증
- React Query의 모든 캐시 항목이나 모든 권한 조합에 대한 완전한 검증
- 모든 브라우저·모바일 환경 및 운영 Stable 승격 판단

로컬 IdP는 의도적으로 end-session endpoint를 제공하지 않는다. 확인되는 로그아웃 범위는 게이트웨이 세션/refresh 폐기, 브라우저 자격 증명 제거와 새 계정에 대한 늦은 응답 격리다. 제품 CSP와 인증·권한 계약은 이 테스트를 위해 완화하지 않는다.

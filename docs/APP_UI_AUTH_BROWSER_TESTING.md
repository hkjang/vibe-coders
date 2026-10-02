# 실제 인증 브라우저 검증

이 검증은 React 콘솔을 **실제 Go HTTP 서버, 임시 SQLite, 로컬 OIDC 공급자**에 연결한다. API 키 권한 검사에는 외부 모델 대신 로컬 합성 응답기를 사용한다. 일반 `web/tests/e2e`의 API fixture 검증과 별도 실행 경로이며, 운영 계정·운영 DB·외부 IdP·유료 모델을 사용하지 않는다. 제품 인증 우회나 테스트 전용 제품 API를 추가하지 않고 `Server.Routes()`를 그대로 실행한다.

## 검증 구성과 범위

- Go 하네스: `internal/proxy/auth_browser_integration_test.go`
- 테스트용 OIDC 공급자: `internal/proxy/oidc_browser_fixture_test.go`
- 테스트용 모델 응답기와 키 저장·권한 검사: `internal/proxy/access_browser_fixture_test.go`
- 복구용 내장 청크 선택·독립 API 세션 검사: `internal/proxy/auth_browser_recovery_fixture_test.go`
- 브라우저 설정과 시나리오: `web/playwright.auth.config.ts`, `web/tests/auth-live/auth-live.spec.ts`, `web/tests/auth-live/access-live.spec.ts`, `web/tests/auth-live/recovery-live.spec.ts`
- 안전 보고서: `web/tests/auth-live/safe-reporter.ts`
- 보고서 누출 방지 회귀: `web/scripts/auth-report-sanitization.test.mjs`

게이트웨이와 IdP는 임의의 loopback 포트에서 실행한다. 임시 DB에는 합성 관리자·읽기 전용 관리자·팀을 만들고, 비밀번호·JWT 서명 비밀·IdP 클라이언트 비밀은 실행마다 생성한다. IdP는 실제 HTTP discovery/JWKS/인증 코드/토큰 엔드포인트와 RSA 서명 ID 토큰을 제공하는 **테스트용 구현**이지 Keycloak 제품 인스턴스는 아니다.

모델 응답기도 loopback에서 실행하며 합성 연결 키로 기존 기본 공급자 등록 경로를 사용한다. 요청 본문·인증 헤더를 보관하지 않고 두 고정 모델 식별자의 호출 수만 센다. 별도 Go 검사는 두 식별자 모두 권한이 있을 때 성공함을 먼저 확인한다. 브라우저 실행에서는 정상 호출이 실제 응답기에 도착하고 권한을 비운 키의 호출은 응답기에 도착하지 않아야 한다. 모델 품질·외부 공급자 연결·스트리밍 검증을 대신하지 않는다.

React 화면은 Vite 개발 서버가 아니라 Go 바이너리에 포함된 정적 배포 파일을 사용한다. 따라서 **웹 빌드 → `internal/appui/dist` 복사 → Go 컴파일** 순서를 지켜야 한다. Go 컴파일 이후 웹 파일만 바꾸어도 이미 컴파일된 화면은 바뀌지 않는다.

| 시나리오        | 실제로 확인하는 내용                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH-LIVE-001` | 잘못된 비밀번호의 401, 정상 로그인, 공급자 딥 링크와 새로고침, 관리자/읽기 전용 관리자 화면 차이, 실제 읽기 허용과 쓰기 거부, 로그아웃 후 브라우저 자격 증명 제거 |
| `AUTH-LIVE-002` | 로컬 IdP 로그인부터 Go 콜백·내부 세션 교환까지의 흐름, 원래 경로와 query 복귀, 교환 fragment 제거, 소비된 일회 교환 코드 재사용 거부, 외부 `return_to` 거부       |
| `AUTH-LIVE-003` | 실제 access token 만료 후 복수 관리 API의 401, refresh 시도 1회와 성공 응답 1회, 인증 유지, 이전 refresh token 재사용 거부                                        |
| `AUTH-LIVE-004` | 다른 탭 로그아웃 전파와 양 탭 자격 증명 제거, 로그아웃한 세션의 refresh 거부, 같은 문서에서 새 계정 로그인 후 이전 관리자 bootstrap 응답이 권한을 되살리지 않음   |
| `AUTH-LIVE-005` | 실제 서버에서 세션을 폐기한 뒤 갱신 요청 1회의 401, 로그인 화면 복귀와 브라우저 자격 증명 제거, 재로그인 후 원래 공급자 화면 복귀                                 |
| `AUTH-LIVE-006` | 실제 API 키 발급 201, 권한 필드 생략과 서버 기본값, 비밀값 일회 표시·브라우저 저장소 비저장·닫기/새로고침/재로그인 후 비노출, 공개 목록에 비밀 필드 부재 |
| `AUTH-LIVE-007` | 실제 권한 저장·빈 배열 저장과 새로고침 유지, 보호된 대화 호출의 200→401→200, 거부된 호출이 모델 응답기에 도착하지 않음 |
| `AUTH-LIVE-008` | 읽기 전용 관리자 화면의 발급·수정·폐기 비활성화, 실제 POST/PATCH 401과 공개 목록 불변 |
| `AUTH-LIVE-009` | 실제 발급 완료 201 응답을 지연한 동안 다른 탭 로그아웃·같은 문서에서 읽기 전용 계정 로그인, 늦은 비밀값·알림·작업창 격리 |
| `AUTH-LIVE-010` | 실제 권한 저장 완료 200 응답을 지연한 동안 같은 계정 전환, 이전 초안·알림 격리와 새 계정의 읽기 전용 권한 유지 |
| `AUTH-LIVE-011` | 내장 공급자 청크 한 건의 실패 후 한글 오류·키보드 초점, 같은 Go의 공급자 조회와 임시 API 키 대화 호출·폐기, 실제 재시도 복구, 기존 관리자 자체 로그인 후 실제 만료·복수 401·갱신 1회·공급자 목록과 로그인 유지 |

다음 세부 조건도 증명 범위를 해석할 때 중요하다.

- access token TTL은 하네스에서 **8초**이다. 003·005·011은 브라우저 메모리 안에서 실제 토큰의 유효기간을 확인하고, 단조 시계 기준 **TTL+5초** 상한 안에서 기존 토큰의 `no-store /auth/me` 응답이 서버 시각상 만료와 401을 함께 확인할 때까지 기다린다. 고정 타이머나 브라우저 시계 변경으로 만료를 가정하지 않는다. 비정상 상태·메타데이터·조회 실패는 즉시 실패시키며 원문 토큰과 시각 값은 보고서에 넣지 않는다.
- 요청 인증과 응답 `Date` 생성 사이에 만료 경계를 넘은 200 응답은 바로 다음 새 요청의 401을 요구한다. 만료가 관측된 뒤의 추가 200을 반복 조회로 숨기지 않는다. 003은 대기 중 access token과 refresh 횟수가 변하지 않았는지도 확인한다. 이후 화면의 명시적 조회로 복수 401, refresh 요청 시도 1회와 성공 응답 1회를 각각 관찰한다. 성공 응답만 세어 실패한 중복 갱신 시도를 놓치지 않도록 구분한다.
- 002의 재사용 검사는 같은 합성 교환의 브라우저 바인딩 쿠키를 복원한 뒤 실행한다. 쿠키가 없어서 생긴 401을 서버의 일회 코드 소비 검증으로 오인하지 않기 위한 조치다. API 응답이나 새 인증 토큰을 만들어 넣지 않는다.
- 004는 `route.fetch()`로 받은 실제 `200/admin` bootstrap 응답, 009와 010은 실제 발급 201·권한 저장 200 응답 한 건을 각각 보류한 뒤 `route.fulfill({ response })`로 그대로 전달한다. 본문·상태를 합성하거나 바꾸는 API mock이 아니다. 새 계정으로 로그인할 때 문서를 새로 로드하지 않으므로, 단순 페이지 종료로 이전 요청을 없앤 테스트도 아니다.
- 009와 010의 저장은 서버에서 이미 완료되었다. 새 읽기 전용 계정의 공개 목록에 생성된 키나 변경된 권한이 보이는 것은 허용하며, 이전 비밀값·초안·알림만 새 세션에 되살아나지 않아야 한다. 로그아웃에 의한 저장 취소·롤백이나 관리자 간 동시 편집 차단을 검증한 것이 아니다.
- 007은 인증이 필요한 `POST /v1/chat/completions`를 사용한다. 익명 조회를 허용하는 `GET /v1/models`의 성공/실패로 키 권한을 판정하지 않는다. 빈 권한 목록은 역할 권한 자동 상속이 아니며, 신규 발급에서 권한 필드를 생략하는 기본값 적용과 구분한다.
- 005는 기존 서버 로그아웃 API로 세션을 폐기하지만 UI 로그아웃을 호출하거나 브라우저 토큰을 지우지 않는다. 실제 만료 후 화면 갱신이 서버의 refresh 거부를 발견하고 로그인으로 복귀해야 한다. 로그인 화면을 직접 열거나 401 응답을 합성하지 않는다.
- 읽기 전용 관리자의 공급자·API 키 쓰기 거부는 기존 서버 계약인 **401**을 확인한다. 이 테스트를 맞추기 위해 제품 응답을 403으로 바꾸지 않는다.
- 하네스는 SSO가 활성화되어 있어 로컬 로그인 뒤의 UI 로그아웃은 `/auth/keycloak/logout`을 사용한다. 이 검증으로 `/auth/logout`의 모든 경로를 브라우저에서 검증했다고 주장하지 않는다.
- 011은 Go에 포함된 정확한 `ProviderPage-<hash>.js` 한 파일만 브라우저에서 요청 중단한다. 공통 청크·HTML·인증·관리 API를 가로채 바꾸거나 오류 이벤트를 합성하지 않는다. 파일이 없거나 여러 개이거나 안전하지 않은 이름이면 하네스가 실패하며, 외부 환경변수로 청크 경로를 바꿀 수 없다.
- 011의 업무 API 연속성 검사는 오류 화면이 남아 있을 때 별도의 실제 8초 로그인 세션을 메모리에서만 발급하고 임시 API 키로 로컬 모델을 호출한 뒤 키 폐기·로그아웃을 확인한다. 관리자 로그인 JWT로 `/v1` 권한을 대신하지 않으며 React 세션 저장값은 교체하지 않는다. 이 별도 세션 역시 만료 제한을 받는다.
- 011의 기존 관리자 이동은 `/admin` HTML의 200만 검사하지 않는다. 별도 문서에서 오류 화면의 허용된 링크를 실제 클릭하고 기존 화면 자체 로그인·설정 탭 클릭·실제 공급자 GET과 목록 표시까지 확인한다. 재시도는 청크 중단을 제거한 후 키보드로 실제 버튼을 실행한다. 진입 JavaScript 자체 실패·인증 제공자 전체 오류·모든 업무 API나 MCP의 가용성은 이 시나리오의 증명 범위가 아니다.
- 011은 기존 관리자의 자격 증명을 브라우저 메모리의 핸들에만 고정하고, 저장값이 바뀌지 않은 채 실제 만료됐음을 확인한 뒤 설정 탭을 연다. 그 문서의 복수 관리 조회 401, 갱신 요청과 성공 응답 각 1회, 공급자 목록 표시와 현재 관리자 세션을 관찰한다. 응답이 동시에 도착했다거나 모든 서버 내부 재시도가 없음을 뜻하지 않는다. 실제 인증 응답은 바꾸지 않으며 시나리오 11개·45초 제한·재시도 0회는 유지한다.

기존 관리자 인증의 결정적인 응답 순서 회귀는 `TestAdminUIAuthBehaviour`가 실제
`admin_ui.go`의 인증·HTTP 블록을 추출해 실행한다. 합성 전송과 DOM으로 여러 401의 단일
갱신, 완료 뒤 늦은 401, 로그인·로그아웃·SSO·초기화와 이전 응답의 겹침을 검사한다.
이 VM 검사는 실제 브라우저·Go 인증 검사를 대체하지 않으며 다른 모든 기존 화면의
렌더링 수명이나 운영 SSO 호환성까지 검증하는 것은 아니다.

## 별도 저장 전 공급자 연결 시나리오

`TestProviderConnectionBrowserIntegration`은 같은 격리 인증 하네스를 사용하지만,
`web/playwright.provider-connection.config.ts`와 `web/tests/provider-connection-live`에서
독립 실행한다. 기존 `AUTH-LIVE-001`~`011` 개수에 합산하지 않는다.

`PROVIDER-LIVE-001`은 새 공급자의 주소·키를 입력해 연결을 확인한 뒤 **저장 전에는 공급자가
없음**을 실제 API와 로컬 응답기의 DB 검사로 확인한다. 명시적으로 저장한 다음 수정 창의 빈 키가
저장된 키를 사용해 연결되는지, 변경한 제한 시간이 아직 DB에는 저장되지 않았는지를 확인한다.
브라우저 관리·인증 응답은 합성하지 않으며 모델 목록 응답기만 loopback 테스트 구현이다.
독립 저장 여부 조회는 실제 로그인으로 새 임시 세션을 만들고 조회 후 폐기한다. React의 8초
세션 만료 경계 때문에 별도 조회가 실패하지 않도록 한 것이며, React 토큰을 교체하거나
실제 연결 검사를 재시도하지 않는다.
추론·운영 공급자 호환성·수정 저장이나 동시 변경 차단까지 증명하는 시나리오는 아니다.

웹 빌드와 embed staging 이후 다음처럼 별도로 실행한다.

```sh
VIBE_PROVIDER_CONNECTION_BROWSER_TEST=1 CGO_ENABLED=0 \
  go test ./internal/proxy -run '^TestProviderConnectionBrowserIntegration$' -count=1 -timeout=2m
```

하네스가 생성한 임시 경로에 성공 여부·검사 수·실패 소스 줄 번호만 저장하고 Go가 검사한 뒤
정리한다. 원문 자식 출력, 요청·응답·키, 추적·스크린샷·ARIA 스냅샷은 보관하지 않는다.
CI에서도 기존 인증 시나리오와 다른 단계로 실행하며 운영 주소·비밀값을 주입하지 않는다.

## 준비와 정적 애셋 포함

아래 예시는 Linux x86-64의 **검증용 checkout 루트**에서 실행한다. 다른 작업의 배포 파일과 섞이지 않도록 별도 checkout을 권장한다. 경로는 현재 사용자가 선택한 checkout에서 계산하며, 특정 임시 worktree 경로를 가정하지 않는다.

필요한 도구는 `go.mod`의 Go 버전, `web/.node-version`의 Node, `web/package.json`의 pnpm 버전과 Docker다. 현재 고정값은 Go 1.26.8, Node 24.20.0, pnpm 11.25.0이다. 아래 이미지와 의존성을 처음 준비하는 단계에는 네트워크가 필요할 수 있다. **오프라인 실행 전 도구·Go 모듈·패키지·이미지 캐시를 미리 준비**해야 한다.

```sh
set -eu
AUTH_CHECKOUT="$(pwd -P)"
AUTH_VERIFICATION="$(mktemp -d /tmp/vibe-auth-browser.XXXXXX)"
AUTH_REPORTS="$(mktemp -d /tmp/vibe-auth-reports.XXXXXX)"
AUTH_IMAGE='mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e'
AUTH_GO_ROOT="$(GOTOOLCHAIN=go1.26.8 go env GOROOT)"
test "$(GOTOOLCHAIN=local "$AUTH_GO_ROOT/bin/go" env GOVERSION)" = go1.26.8

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
mkdir -p "$AUTH_CHECKOUT/web/test-results"
```

`pnpm-lock.yaml`은 변경하지 않는다. `web/dist`와 embed staging은 생성물이다. 이미 실행 중인 다른 작업의 checkout에서 이 복사를 수행하지 않는다. 하네스는 포함된 `index.html`과 `/app/assets/` 파일이 없으면 개발 서버로 대체하지 않고 실패한다.

새 checkout의 `web/test-results`는 외부 보고서 디렉터리를 연결할 빈 mountpoint로 미리 만든다. checkout을 읽기 전용으로 연결한 뒤에는 Docker가 이 경로를 생성할 수 없다. 실제 보고서는 아래의 별도 쓰기 mount인 `AUTH_REPORTS`에만 생성된다.

## 오프라인 컴파일과 고정 브라우저 실행

앞 단계에서 준비한 동일 checkout과 `AUTH_VERIFICATION`을 사용한다. 다음 컴파일은 준비 단계에서 버전을 확인한 Go 실행 파일을 직접 실행하고 네트워크 조회를 끈다. 자동 toolchain 선택기의 체크섬 확인도 네트워크를 요구할 수 있어 `GOTOOLCHAIN=local`을 사용한다. 캐시가 부족하면 실패하므로, 운영 환경 설정을 가져오거나 임의 의존성으로 대체하지 않는다.

```sh
(
  cd "$AUTH_CHECKOUT"
  GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    "$AUTH_GO_ROOT/bin/go" test -c -o "$AUTH_VERIFICATION/auth-browser.test" ./internal/proxy
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

위 예시는 **외부 네트워크 차단 + checkout·바이너리 디렉터리 읽기 전용** 조건에서 열한 시나리오를 실행한다. 컨테이너 내부 loopback 통신은 계속 사용한다. 별도 전용 `AUTH_REPORTS`만 `/workspace/web/test-results`에 쓰기 가능하게 연결하며, DB·브라우저 임시 파일은 `/tmp` tmpfs를 사용한다. 컨테이너 루트 파일시스템 전체에 `--read-only`를 적용한 검증은 아니다. 브라우저 요청도 하네스의 정확한 게이트웨이·IdP origin 두 개만 허용하며, 다른 origin 요청을 발견하면 실패한다. 모델 응답기에는 Go 서버만 연결한다.

하네스가 자신의 checkout을 찾을 수 있도록 작업 디렉터리를 `/workspace`로 유지한다. `APP_BASE_URL`, 계정 정보, IdP 주소는 하네스가 생성해서 자식 프로세스에 전달한다. 사용자가 운영 주소나 비밀번호를 주입해 실행하는 방식은 지원하지 않는다. `VIBE_AUTH_BROWSER_TEST=1`이 없으면 실제 브라우저 통합 테스트는 명시적으로 건너뛴다.

실행이 끝나면 `AUTH_REPORTS`의 **안전 요약 파일만** 보관하고, 본인이 `mktemp -d`로 만든 `AUTH_VERIFICATION`과 `AUTH_REPORTS` 경로를 각각 확인하여 정리한다. 다른 checkout·공유 임시 디렉터리·사용자 홈을 재귀 삭제하지 않는다.

## 결과와 민감 정보 취급

보고서의 컨테이너 내부 경로는 `/workspace/web/test-results/auth-live-summary.json`이며, 위 명령으로 실행하면 호스트의 **`$AUTH_REPORTS/auth-live-summary.json`**에 생성된다. checkout의 기존 `web/test-results` 파일을 덮어쓰지 않는다. 직접 실행과 CI의 경로는 `web/test-results/auth-live-summary.json`이다. 전체 상태와 각 시나리오의 다음 항목만 기록한다.

- 고정 허용 목록 `AUTH-LIVE-001`~`AUTH-LIVE-011` 식별자 또는 `UNKNOWN`
- 테스트 상태와 소요 시간
- 진단에 필요한 경우 허용된 세 테스트 소스 파일의 숫자 행 번호만 (`lastSourceLine`, `failureSourceLine`)

테스트 제목 원문, 단계 설명, URL, 요청/응답 본문, 헤더, 오류 메시지·스택, 첨부 파일, 비밀번호·토큰은 보고서에 넣지 않는다. 자식 프로세스의 stdout/stderr도 버린다. trace·video·screenshot은 꺼져 있고 HAR나 storage-state 저장도 추가하지 않는다. Playwright의 실패 문맥 파일은 일반 화면 캡처와 별개이므로 복사 안내용 ARIA 스냅샷도 끄고, 비공개 출력 경로를 하네스의 임시 영역으로 분리한다. 외부 보고서 경로에는 안전 요약 JSON만 남긴다.

브라우저 프로필·실패 문맥 등 임시 파일은 Go `t.TempDir()` 아래의 **0700 권한 `browser-tmp`**에 모으고 정상 종료 및 하네스가 처리하는 timeout 후 정리한다. `preserveOutput: never`만으로 강제 종료 직전의 실패 파일을 보호할 수 있다고 가정하지 않는다. 외부에서 전체 실행 환경을 강제 종료한 경우까지 정리를 보장한다는 뜻은 아니다.

Node 누출 방지 테스트는 실제 TypeScript reporter에 합성 인증·API 키 비밀 마커를 주입해 고정 시나리오/소스 파일·상태 허용 목록, 유효한 숫자 행 번호·소요 시간, stdout/stderr 비출력 및 추가 파일 부재를 확인한다. reporter 구현을 복제한 mock 테스트가 아니다.

```sh
(
  cd "$AUTH_CHECKOUT/web"
node --test scripts/auth-report-sanitization.test.mjs
)
```

실제 Chromium 실패 경로 검사도 제공한다. 고정 Playwright 이미지와 설치된 브라우저가 있는 환경에서
같은 명령에 `VIBE_AUTH_BROWSER_ARTIFACT_TEST=1`을 지정한다. 일반 Node 검사에서는 이 사례를
명시적으로 건너뛰고, `auth-browser` CI에서는 별도 필수 단계로 실행한다. 기존 키 발급과 신규 복구
소스 파일 각각에서 합성 비밀 마커를 넣은 화면을 의도적으로 실패시켜 원시 실패 문맥의 경로와
외부 요약을 확인한다. 운영 자격 증명은 사용하지 않는다.

실패 진단은 Go 종료 상태와 안전 요약의 시나리오 ID·행 번호를 함께 확인한다. `lastSourceLine`은
마지막으로 시작한 단계이므로 `finally`의 정리 호출일 수 있다. `failureSourceLine`은 허용된
테스트 파일의 유효한 오류 스택 위치를 우선 사용하고, 없으면 실패한 테스트에서 처음 관측한
실패 단계의 허용된 숫자 행 번호를 보존한다. 이는 관측 위치이며 근본 원인을 확정하는 정보가
아니다. 정상 완료한 테스트의 내부 처리된 단계 오류는 이 대체 위치로 보고하지 않는다.
실제 Chromium의 의도적인 시간 초과와 정리 호출을 함께 실행하는 보호 검사로 이 경계를
검증하며 실제 인증 시나리오의 45초 제한이나 재시도 0회 설정은 변경하지 않는다.

단계 설명이나 전체 스택을 출력하도록 reporter를 바꾸어 진단하지 않는다. Playwright 실행 전
실패했다면 새 요약 파일이 없을 수 있다. 매 실행마다 새 `AUTH_REPORTS`를 만들고, 이전 실행의
요약을 이번 성공 근거로 삼지 않는다. 원문 인증 자료는 보관·업로드 대상이 아니다.

## CI와 남아 있는 검증

`.github/workflows/ci.yml`의 `auth-browser` job은 실제 Chromium 실패 산출물 검사를 먼저 실행하고, `frontend`의 정적 애셋 artifact를 받은 뒤 embed 경로에 배치한다. 고정 Playwright 이미지에서 frozen 의존성과 실제 Go 통합 테스트를 실행하며 worker 1개, retry 0회다. 전체 job 제한은 15분, Go 테스트 제한은 6분, 하네스 자식 실행 제한은 4분이다. 업로드 대상은 안전 요약 JSON 한 개뿐이며, 실패해도 인증 trace나 전체 `test-results` 디렉터리를 업로드하지 않는다.

이 검증은 다음을 대신하지 않는다.

- 실제 Keycloak 배포의 설정·버전·인증서 호환성 및 운영 계정 검증
- HTTPS·서로 다른 사이트 간 쿠키 정책과 RP-initiated IdP end-session 로그아웃
- 모든 탭이 따로 발급받은 서버 세션을 한 번에 취소하는 기능의 검증
- React Query의 모든 캐시 항목이나 모든 권한 조합에 대한 완전한 검증
- 키 회전·폐기·팀별 소유권의 모든 조합, 실제 공급자·과금·스트리밍, 관리자 간 동시 변경 충돌
- 모든 브라우저·모바일 환경 및 운영 Stable 승격 판단

로컬 IdP는 의도적으로 end-session endpoint를 제공하지 않는다. 확인되는 로그아웃 범위는 게이트웨이 세션/refresh 폐기, 브라우저 자격 증명 제거와 새 계정에 대한 늦은 응답 격리다. 제품 CSP와 인증·권한 계약은 이 테스트를 위해 완화하지 않는다.

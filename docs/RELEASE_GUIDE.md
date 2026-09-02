# 릴리즈 가이드 (Release Guide)

AI 코딩 프록시 게이트웨이의 빌드·태깅·GitHub 릴리즈·오프라인 배포 패키지 산출 절차를 한 문서에 정리했습니다.

---

## 목차

1. [릴리즈 전 체크리스트](#1-릴리즈-전-체크리스트)
2. [버전 체계](#2-버전-체계)
3. [로컬 개발 서버 기동](#3-로컬-개발-서버-기동)
4. [Git 커밋 & 푸시](#4-git-커밋--푸시)
5. [오프라인 배포 패키지 빌드 (Docker 이미지)](#5-오프라인-배포-패키지-빌드-docker-이미지)
6. [GitHub Release 생성](#6-github-release-생성)
7. [폐쇄망 배포](#7-폐쇄망-배포)
8. [릴리즈 후 검증](#8-릴리즈-후-검증)
9. [롤백 절차](#9-롤백-절차)

---

## 1. 릴리즈 전 체크리스트

릴리즈 전 아래 항목을 반드시 확인하세요.

- [ ] `go test ./...` 전체 테스트 통과
- [ ] `go build ./cmd/gateway` 빌드 오류 없음
- [ ] `pnpm --dir web install --frozen-lockfile` 및 `pnpm --dir web check` 통과
- [ ] `web/dist/index.html`과 hashed `web/dist/assets/*` 생성 확인
- [ ] v0.80.0 이상은 Go+npm 통합 `SBOM.spdx.json`과 Frontend 포함 `THIRD_PARTY_LICENSES.md` 갱신
- [ ] 최종 이미지 `scripts/container-smoke.sh` 검증 통과
- [ ] `CHANGELOG` 또는 커밋 메시지에 변경사항 정리
- [ ] `GATEWAY_SECRET` 운영 값으로 설정 확인 (기본 개발값 절대 금지)
- [ ] `ADMIN_TOKEN` 설정 여부 확인
- [ ] Docker `proxy-gateway-data` volume과 0600 `gateway.env` 백업 및 `.sha256` 검증 완료
- [ ] GitHub 원격 저장소 접근 권한 확인 (`gh auth status`)

---

## 2. 버전 체계

[Semantic Versioning](https://semver.org/lang/ko/) 을 따릅니다.

| 유형 | 예시 | 설명 |
|------|------|------|
| Major | `v1.0.0` | 하위 호환성 깨지는 변경 |
| Minor | `v0.2.0` | 하위 호환 기능 추가 |
| Patch | `v0.1.1` | 버그 수정 |
| Snapshot | `20260604-1400-abc1234` | 버전 미지정 시 자동 생성 |

Git 태그는 반드시 `v` 접두사를 포함합니다 (예: `v0.1.0`).

---

## 3. 로컬 개발 서버 기동

릴리즈 전 로컬에서 동작을 검증합니다.

`go build`는 `internal/appui/dist`만 embed하므로 직접 바이너리를 만들 때는 먼저
frontend를 frozen lockfile로 빌드하고 산출물을 overlay해야 합니다. 추적 중인
`.gitkeep`은 보존하고 이전 hashed asset만 제거합니다. 공식 릴리스에서는 이 절차와
동일한 작업을 Dockerfile의 Node → Go builder stage가 수행합니다.

```bash
corepack enable
pnpm --dir web install --frozen-lockfile
VITE_UI_VERSION=v0.81.0 pnpm --dir web build
find internal/appui/dist -mindepth 1 ! -name '.gitkeep' -delete
cp -R web/dist/. internal/appui/dist/
test -s internal/appui/dist/index.html
test -n "$(find internal/appui/dist/assets -type f -print -quit)"
```

PowerShell에서는 overlay 전에 다음과 같이 generated 파일만 정리합니다.

```powershell
Get-ChildItem internal/appui/dist -Force |
  Where-Object Name -ne '.gitkeep' |
  Remove-Item -Recurse -Force
Copy-Item web/dist/* internal/appui/dist/ -Recurse -Force
```

### Windows / PowerShell

```powershell
$env:UPSTREAM_API_KEY = "sk-..."
$env:GATEWAY_SECRET   = "dev-only-secret"
$env:ADMIN_TOKEN      = "dev-admin"
$env:UI_APP_ENABLED   = "true"
go run -ldflags "-X vibe-coders/internal/proxy.AppVersion=v0.81.0" ./cmd/gateway
```

### Linux / macOS

```bash
UPSTREAM_API_KEY=sk-... \
GATEWAY_SECRET=dev-only-secret \
ADMIN_TOKEN=dev-admin \
UI_APP_ENABLED=true \
go run -ldflags "-X vibe-coders/internal/proxy.AppVersion=v0.81.0" ./cmd/gateway
```

기동 후 헬스체크:

```bash
curl http://localhost:8080/health   # {"status":"ok"}
curl http://localhost:8080/ready    # {"status":"ready"}
curl -I http://localhost:8080/app   # 308 Location: /app/
curl http://localhost:8080/app/providers
```

`/admin`은 Legacy Stable Console로 항상 유지됩니다. `/app/`은 Next Console Preview이며
기본 OFF이므로 `UI_APP_ENABLED=true`일 때만 활성화됩니다.

---

## 4. Git 커밋 & 푸시

### 4.1 최초 저장소 초기화 (첫 릴리즈 시)

```powershell
git init
git remote add origin https://github.com/hkjang/vibe-coders.git
git config user.name "hkjang"
git config user.email "hkjang@users.noreply.github.com"
```

### 4.2 변경사항 커밋

커밋 메시지는 [Conventional Commits](https://www.conventionalcommits.org/ko/) 규칙을 따릅니다.

```powershell
# 기존 추적 파일과 이번 변경에서 의도한 새 파일만 분리해 스테이징합니다.
git add -u
git add -- web internal/appui docs/APP_UI_ROADMAP.md `
  internal/proxy/appui_config.go internal/proxy/appui_config_test.go `
  scripts/container-smoke.sh scripts/generate-source-sbom.sh scripts/merge-source-sbom.mjs

# .gitframe/, output/, seed.sql이 나오면 커밋하지 말고 스테이징을 정정합니다.
git diff --cached --name-only
git diff --cached --name-only | Select-String -Pattern '(^|/)(\.gitframe|output)(/|$)|(^|/)seed\.sql$'
git commit -m "feat: <변경 내용 요약>"
```

새 파일 경로는 실제 변경 범위에 맞게 명시적으로 추가합니다. `.gitframe/`, `output/`,
`seed.sql`은 로컬 작업 산출물 또는 개발 데이터이므로 소스 커밋, Docker build context,
릴리즈 자산에 포함하지 않습니다.

| 접두사 | 용도 |
|--------|------|
| `feat:` | 새로운 기능 추가 |
| `fix:` | 버그 수정 |
| `docs:` | 문서 변경 |
| `refactor:` | 코드 리팩터링 |
| `test:` | 테스트 추가/수정 |
| `chore:` | 빌드/설정 변경 |

### 4.3 원격 저장소 푸시

```powershell
git push -u origin master
```

### 4.4 릴리즈 태그 생성 & 푸시

```powershell
$VERSION = "v0.81.0"
git tag -a $VERSION -m "Release $VERSION"
git push origin $VERSION
```

---

## 5. 오프라인 배포 패키지 빌드 (Docker 이미지)

릴리즈 스크립트 한 번으로 3-stage Docker 이미지 빌드 → container smoke → tar.gz 압축
→ SHA256 체크섬 → 오프라인 가이드 생성을 수행합니다. v0.80.0부터는 versioned 통합
SBOM과 제3자 라이선스 목록도 함께 산출합니다. PowerShell 경로도 동일한 smoke를 위해
Bash, curl, Python 3가 필요합니다.
대상 플랫폼이 빌드 호스트와 다르면 최종 이미지를 실행할 수 있도록 Docker binfmt/QEMU를
먼저 구성하거나 대상 아키텍처 호스트에서 빌드해야 합니다. Smoke를 실행할 수 없는
cross-platform 이미지는 릴리스 스크립트가 패키징하지 않습니다.

### Windows / PowerShell

```powershell
pwsh -File scripts/release.ps1 -Version v0.81.0
```

### Linux / macOS

```bash
./scripts/release.sh -v v0.81.0 -p linux/amd64
```

### 스크립트 처리 단계

| 단계 | 설명 |
|------|------|
| **[1/5] docker build** | Node 24+pnpm frozen → Go 1.26.8 embed → distroless nonroot 3-stage 이미지 생성 |
| **[verify] container smoke** | `/admin`, `/app` 308/deep link, hashed asset cache, `/auth/me` build version 검증 |
| **[2/5] docker save** | OCI tar 파일 추출 |
| **[3/5] gzip 압축** | tar → tar.gz (최적 압축) |
| **[4/5] 가이드 생성** | `README-offline-{version}.md` 산출 |
| **[5/5] 컴플라이언스·운영** | v0.80.0 이상 versioned SBOM·라이선스·env/volume 운영 helper 산출 |

v0.80.0 미만 버전을 다시 패키징할 때는 호환성을 위해 기존 4단계와 3개 필수 자산을
유지합니다. 최종 런타임에는 Node.js가 없고 React 정적 에셋은 Go 바이너리에 embed됩니다.
Docker `VERSION` build arg는 `VITE_UI_VERSION`과
`vibe-coders/internal/proxy.AppVersion` ldflag 양쪽에 같은 값을 주입합니다. 정식 SemVer
릴리즈에서는 `VCS_REF`도 annotated tag가 가리키는 커밋으로 주입되며, 스크립트는 작업
트리가 깨끗한지, 로컬·origin 태그와 `origin/master`가 현재 HEAD를 동일하게 가리키는지,
해당 커밋의 GitHub `CI` push 실행이 성공했는지 확인한 뒤 빌드합니다. Dockerfile의 Node,
Go, Distroless 기반 이미지는 멀티아키텍처 manifest digest로 고정합니다.
container smoke는 이미지의 OCI `org.opencontainers.image.version`과
`org.opencontainers.image.revision` 라벨까지 검증합니다.

### 산출물

```
release/
  ai-coding-proxy-gateway-v0.81.0.tar.gz        ← Docker 이미지 패키지
  ai-coding-proxy-gateway-v0.81.0.tar.gz.sha256 ← SHA256 체크섬
  README-offline-v0.81.0.md                      ← 오프라인 배포 가이드
  SBOM-v0.81.0.spdx.json                         ← Go+npm 통합 SPDX SBOM
  THIRD_PARTY_LICENSES-v0.81.0.md                ← Go·Frontend 라이선스 목록
  init-deployment-env-v0.81.0.sh                 ← 운영 env 원자 생성·검증
  backup-volume-v0.81.0.sh                       ← named volume·env 백업·복구
```

### 파라미터 옵션

```powershell
# 버전 지정
pwsh -File scripts/release.ps1 -Version v0.81.0

# 이미지 이름 변경
pwsh -File scripts/release.ps1 -Version v0.81.0 -Image my-gateway

# ARM64 빌드 (애플 실리콘 / ARM 서버)
pwsh -File scripts/release.ps1 -Version v0.81.0 -Platform linux/arm64
```

---

## 6. GitHub Release 생성

`gh` CLI 를 이용해 빌드된 패키지 파일을 GitHub Release 에 첨부합니다.

### 6.1 인증 상태 확인

```powershell
gh auth status
```

### 6.2 릴리즈 생성 & 파일 업로드

```powershell
# 스크립트를 사용하여 릴리즈 업로드
pwsh -File scripts/gh_release.ps1 -Version v0.81.0 -PrevVersion v0.80.0
```

raw `gh release create`로 직접 게시하지 않습니다. 위 스크립트는 clean tree, annotated tag,
`origin/master`와 성공한 CI, 7개 payload의 manifest/hash, tagged canonical
SBOM·라이선스·운영 helper를 게시 전에 검증합니다. 직접 명령은 이 fail-closed gate를
우회하므로 지원하지 않습니다.

### 6.3 릴리즈 확인

```powershell
gh release view v0.81.0 --repo hkjang/vibe-coders
```

또는 브라우저에서 직접 확인:

```
https://github.com/hkjang/vibe-coders/releases
```

---

## 7. 폐쇄망 배포

### 7.1 파일 전달

`release/` 폴더 전체를 USB 또는 망연계 시스템으로 폐쇄망 서버에 복사합니다.

```
ai-coding-proxy-gateway-v0.81.0.tar.gz
ai-coding-proxy-gateway-v0.81.0.tar.gz.sha256
README-offline-v0.81.0.md
SBOM-v0.81.0.spdx.json
THIRD_PARTY_LICENSES-v0.81.0.md
init-deployment-env-v0.81.0.sh
backup-volume-v0.81.0.sh
```

### 7.2 무결성 확인

```bash
sha256sum -c ai-coding-proxy-gateway-v0.81.0.tar.gz.sha256
# 정상: ai-coding-proxy-gateway-v0.81.0.tar.gz: OK
```

### 7.3 이미지 적재

```bash
gunzip -c ai-coding-proxy-gateway-v0.81.0.tar.gz | docker load
# 정상: Loaded image: ai-coding-proxy-gateway:v0.81.0
```

### 7.4 단일 컨테이너 실행

```bash
chmod 0700 init-deployment-env-v0.81.0.sh backup-volume-v0.81.0.sh
sudo env GATEWAY_VERSION=v0.81.0 \
  ./init-deployment-env-v0.81.0.sh /opt/proxy-gateway/gateway.env
docker volume create proxy-gateway-data >/dev/null
docker run -d --name proxy-gateway --restart=always \
  -p 8080:8080 \
  --mount source=proxy-gateway-data,target=/data \
  --env-file /opt/proxy-gateway/gateway.env \
  ai-coding-proxy-gateway:v0.81.0
```

초기화 helper가 upstream key를 숨김 입력받습니다. `ADMIN_TOKEN`과 `GATEWAY_SECRET`은
최초 1회만 생성하고 env 파일과 데이터 볼륨을 함께 백업해야 합니다. 두 versioned helper는
체크섬 manifest와 tagged source 비교 대상이므로 별도 소스 checkout 없이 폐쇄망에서 사용합니다.

### 7.5 docker compose 실행

```bash
sudo env GATEWAY_VERSION=v0.81.0 \
  ./init-deployment-env-v0.81.0.sh /opt/proxy-gateway/gateway.env
docker compose --env-file /opt/proxy-gateway/gateway.env up -d
docker compose --env-file /opt/proxy-gateway/gateway.env logs -f gateway
```

이 방식은 검토한 `docker-compose.yml`도 함께 전달한 경우에만 사용합니다. Compose의
`gateway_data` 키는 실제 이름 `proxy-gateway-data`로 고정되어 단일 컨테이너
방식과 같은 데이터를 사용합니다. 초기화 스크립트는 새 secret을 원자적으로 생성하고,
기존 env는 검증한 뒤 요청한 `GATEWAY_VERSION`만 원자 갱신하며 secret은 회전하지 않습니다.
`gateway.env`는 항상 0600으로 유지하고
`docker compose down -v`는 실행하지 마세요.

---

## 8. 릴리즈 후 검증

### 8.1 헬스체크

```bash
curl -fsS http://<HOST>:8080/health   # {"status":"ok"}
curl -fsS http://<HOST>:8080/ready    # {"status":"ready"}
```

### 8.2 관리자 UI 접속

```
Legacy Stable Console: http://<HOST>:8080/admin
Next Console Preview:  http://<HOST>:8080/app/
```

- `/app`은 기본 OFF입니다. Preview 환경은 `UI_APP_ENABLED=true`로 기동합니다.
- 헤더의 "관리자 토큰" 입력란에 `ADMIN_TOKEN` 값 입력
- 대시보드에서 요청 수·토큰·비용 정상 집계 확인
- `/app/providers` 같은 client-side deep link를 직접 열고 새로고침해도 200인지 확인

패키징을 수행한 호스트에서는 전체 이미지 계약을 한 번에 재검증할 수 있습니다.

```bash
bash scripts/container-smoke.sh ai-coding-proxy-gateway:v0.81.0 v0.81.0
```

이 검증은 `/admin` 안정 화면, `/app` 308, deep link, 존재하지 않는 asset 404,
hashed asset immutable cache와 `/auth/me`의 빌드 버전을 확인합니다.

### 8.3 프록시 동작 확인

```bash
curl http://<HOST>:8080/v1/chat/completions \
  -H "Authorization: Bearer <PROXY_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"hello"}]}'
```

### 8.4 메트릭 확인

```bash
curl http://<HOST>:8080/metrics | grep proxy_requests_total
```

---

## 9. 롤백 절차

문제가 발생한 경우 이전 버전으로 빠르게 복구합니다.

### 9.1 이전 이미지로 롤백 (Docker)

```bash
# 컨테이너 중지 & 제거
docker stop proxy-gateway
docker rm proxy-gateway

# 이전 버전으로 기동
docker run -d --name proxy-gateway --restart=always \
  -p 8080:8080 \
  --mount source=proxy-gateway-data,target=/data \
  --env-file /opt/proxy-gateway/gateway.env \
  ai-coding-proxy-gateway:v0.0.9   ← 이전 버전
```

### 9.2 이전 이미지가 없는 경우

이전 버전의 `tar.gz` 를 다시 로드합니다.

```bash
gunzip -c ai-coding-proxy-gateway-v0.0.9.tar.gz | docker load
docker run -d ... ai-coding-proxy-gateway:v0.0.9
```

### 9.3 DB 복구가 필요한 경우

DB 스키마 변경이 포함된 릴리즈를 롤백할 경우 검증된 named-volume archive에서
복구합니다. gateway 런타임은 distroless이므로 외부 helper image나 container 내부
shell을 쓰지 않습니다. `backup-volume.sh`가 정확한 gateway 이미지를 실행하지 않은
carrier로 만들어 `docker cp`만 사용합니다.

```bash
# 사전에 같은 방식으로 만든 .tar.gz와 .tar.gz.sha256이 함께 있어야 합니다.
# container만 제거하며 -v는 절대 붙이지 않습니다.
docker compose --env-file /opt/proxy-gateway/gateway.env down

scripts/backup-volume.sh restore \
  --image ai-coding-proxy-gateway:v0.81.0 \
  --volume proxy-gateway-data \
  --env-file /opt/proxy-gateway/gateway.env \
  --output-dir /opt/proxy-gateway/backups \
  --archive /opt/proxy-gateway/backups/gateway-volume-<UTC>-<pid>.tar.gz \
  --confirm 'RESTORE proxy-gateway-data'

docker compose --env-file /opt/proxy-gateway/gateway.env up -d
curl -fsS http://localhost:8080/ready
```

스크립트는 volume/archive 이름, SHA256, 내부 checksum, SQLite, container 참조와 정확한
확인 문구를 모두 검증하고 현재 volume의 안전 archive를 만든 뒤에만 교체합니다.
`GATEWAY_SECRET`이 다르면 기본적으로 중단하며, 백업 env까지 복원하기로 명시적으로
결정한 경우에만 `--restore-env`를 추가합니다. 이 옵션은 현재 env가 분실된 경우에도
archive의 검증된 사본을 0600으로 원자 복원합니다. 자세한 보호 절차는
[운영 가이드](./OPERATIONS.md#6-백업--복구)를 따르세요.

---

## 관련 문서

- [운영 가이드](./OPERATIONS.md) — 기동/종료, 헬스체크, 백업·복구, 장애 대응 런북
- [관리자 가이드](./ADMIN_GUIDE.md) — 어드민 UI 탭 사용법, 일상/주간/월간 운영 체크리스트
- [사용자 가이드](./USER_GUIDE.md) — Roo Code / Cline / Cursor / OpenAI SDK 연결

## 릴리즈 후 확인

```bash
./scripts/verify_release.sh vX.Y.Z      # 방금 낸 한 개
./scripts/verify_release.sh --all       # 전체 감사
```

릴리즈 노트만 올리고 오프라인 패키지를 빠뜨리기 쉽습니다 — 실제로 23개 릴리즈가
자산 없이 나갔고, 아무것도 실패하지 않아 지적받을 때까지 드러나지 않았습니다. 위
스크립트는 v0.79.8 이하의 기존 자산 3종, v0.80.0 이상의 SBOM·라이선스·운영 helper 포함 7종과
로컬·origin annotated 태그를 확인합니다. 단일 버전을 확인할 때는 업로드된 이미지
archive와 체크섬 자산을 내려받아 SHA256도 다시 계산합니다. 따라서 과거 릴리즈 전체
감사는 자산·태그 계약을 빠르게 확인하고, 방금 배포한 단일 릴리즈는 무결성까지 확인합니다.

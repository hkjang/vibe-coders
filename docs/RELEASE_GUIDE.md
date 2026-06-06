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
- [ ] `CHANGELOG` 또는 커밋 메시지에 변경사항 정리
- [ ] `GATEWAY_SECRET` 운영 값으로 설정 확인 (기본 개발값 절대 금지)
- [ ] `ADMIN_TOKEN` 설정 여부 확인
- [ ] `data/` 디렉토리 백업 완료 (운영 서버)
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

### Windows / PowerShell

```powershell
$env:UPSTREAM_API_KEY = "sk-..."
$env:GATEWAY_SECRET   = "dev-only-secret"
$env:ADMIN_TOKEN      = "dev-admin"
go run ./cmd/gateway
```

### Linux / macOS

```bash
UPSTREAM_API_KEY=sk-... \
GATEWAY_SECRET=dev-only-secret \
ADMIN_TOKEN=dev-admin \
go run ./cmd/gateway
```

기동 후 헬스체크:

```bash
curl http://localhost:8080/health   # {"status":"ok"}
curl http://localhost:8080/ready    # {"status":"ready"}
```

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
git add .
git commit -m "feat: <변경 내용 요약>"
```

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
$VERSION = "v0.1.0"
git tag -a $VERSION -m "Release $VERSION"
git push origin $VERSION
```

---

## 5. 오프라인 배포 패키지 빌드 (Docker 이미지)

릴리즈 스크립트 한 번으로 Docker 이미지 빌드 → tar.gz 압축 → SHA256 체크섬 → 오프라인 가이드 생성까지 자동으로 수행합니다.

### Windows / PowerShell

```powershell
pwsh -File scripts/release.ps1 -Version v0.1.0
```

### Linux / macOS

```bash
./scripts/release.sh -v v0.1.0 -p linux/amd64
```

### 스크립트 처리 단계

| 단계 | 설명 |
|------|------|
| **[1/4] docker build** | 멀티스테이지 빌드로 distroless 최소 이미지 생성 |
| **[2/4] docker save** | OCI tar 파일 추출 |
| **[3/4] gzip 압축** | tar → tar.gz (최적 압축) |
| **[4/4] 가이드 생성** | `README-offline-{version}.md` 산출 |

### 산출물

```
release/
  ai-coding-proxy-gateway-v0.1.0.tar.gz        ← Docker 이미지 패키지
  ai-coding-proxy-gateway-v0.1.0.tar.gz.sha256 ← SHA256 체크섬
  README-offline-v0.1.0.md                      ← 오프라인 배포 가이드
```

### 파라미터 옵션

```powershell
# 버전 지정
pwsh -File scripts/release.ps1 -Version v0.2.0

# 이미지 이름 변경
pwsh -File scripts/release.ps1 -Version v0.1.0 -Image my-gateway

# ARM64 빌드 (애플 실리콘 / ARM 서버)
pwsh -File scripts/release.ps1 -Version v0.1.0 -Platform linux/arm64
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
pwsh -File scripts/gh_release.ps1 -Version v0.1.3
```

또는 직접 명령어로 실행 (릴리즈 노트 파일을 사용하는 것이 Windows 환경 등에서 파싱 구문 오류를 방지하기에 좋습니다):

```bash
# 1. 릴리즈 노트 파일 작성 (release/release-notes.txt)
# 2. 릴리즈 생성 명령어 실행
gh release create v0.1.3 \
  "release/ai-coding-proxy-gateway-v0.1.3.tar.gz" \
  "release/ai-coding-proxy-gateway-v0.1.3.tar.gz.sha256" \
  "release/README-offline-v0.1.3.md" \
  --repo hkjang/vibe-coders \
  --title "v0.1.3 - AI Coding Proxy Gateway" \
  --notes-file "release/release-notes.txt"
```

### 6.3 릴리즈 확인

```powershell
gh release view v0.1.3 --repo hkjang/vibe-coders
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
ai-coding-proxy-gateway-v0.1.0.tar.gz
ai-coding-proxy-gateway-v0.1.0.tar.gz.sha256
README-offline-v0.1.0.md
```

### 7.2 무결성 확인

```bash
sha256sum -c ai-coding-proxy-gateway-v0.1.0.tar.gz.sha256
# 정상: ai-coding-proxy-gateway-v0.1.0.tar.gz: OK
```

### 7.3 이미지 적재

```bash
gunzip -c ai-coding-proxy-gateway-v0.1.0.tar.gz | docker load
# 정상: Loaded image: ai-coding-proxy-gateway:v0.1.0
```

### 7.4 단일 컨테이너 실행

```bash
docker run -d --name proxy-gateway --restart=always \
  -p 8080:8080 \
  -v /opt/proxy-gateway/data:/data \
  -e UPSTREAM_BASE_URL=https://api.openai.com \
  -e UPSTREAM_API_KEY=sk-... \
  -e ADMIN_TOKEN=$(openssl rand -hex 32) \
  -e GATEWAY_SECRET=$(openssl rand -hex 32) \
  -e MODEL_PRICING_KRW_PER_1M='{"gpt-4.1-mini":{"input_krw_per_1m":540,"output_krw_per_1m":2160}}' \
  ai-coding-proxy-gateway:v0.1.0
```

### 7.5 docker compose 실행

```bash
export GATEWAY_VERSION=v0.1.0
export UPSTREAM_API_KEY=sk-...
export ADMIN_TOKEN=$(openssl rand -hex 32)
export GATEWAY_SECRET=$(openssl rand -hex 32)
docker compose up -d
docker compose logs -f gateway
```

---

## 8. 릴리즈 후 검증

### 8.1 헬스체크

```bash
curl -fsS http://<HOST>:8080/health   # {"status":"ok"}
curl -fsS http://<HOST>:8080/ready    # {"status":"ready"}
```

### 8.2 어드민 UI 접속

```
http://<HOST>:8080/admin
```

- 헤더의 "관리자 토큰" 입력란에 `ADMIN_TOKEN` 값 입력
- 대시보드에서 요청 수·토큰·비용 정상 집계 확인

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
  -v /opt/proxy-gateway/data:/data \
  -e ... \
  ai-coding-proxy-gateway:v0.0.9   ← 이전 버전
```

### 9.2 이전 이미지가 없는 경우

이전 버전의 `tar.gz` 를 다시 로드합니다.

```bash
gunzip -c ai-coding-proxy-gateway-v0.0.9.tar.gz | docker load
docker run -d ... ai-coding-proxy-gateway:v0.0.9
```

### 9.3 DB 복구가 필요한 경우

DB 스키마 변경이 포함된 릴리즈를 롤백할 경우 백업에서 복구합니다.

```bash
docker compose stop gateway
mv data/gateway.db data/gateway.db.broken
tar -xzf backups/gateway-YYYYMMDD-HHMM.tar.gz -C /tmp
cp /tmp/data/gateway.db data/gateway.db
docker compose up -d gateway
curl -fsS http://localhost:8080/ready
```

> **주의**: 롤백 시 `GATEWAY_SECRET` 은 백업 시점과 동일한 값을 유지해야 합니다.
> 다르면 Provider API key 복호화가 실패하므로 어드민에서 키를 재입력해야 합니다.

---

## 관련 문서

- [운영 가이드](./OPERATIONS.md) — 기동/종료, 헬스체크, 백업·복구, 장애 대응 런북
- [관리자 가이드](./ADMIN_GUIDE.md) — 어드민 UI 탭 사용법, 일상/주간/월간 운영 체크리스트
- [사용자 가이드](./USER_GUIDE.md) — Roo Code / Cline / Cursor / OpenAI SDK 연결

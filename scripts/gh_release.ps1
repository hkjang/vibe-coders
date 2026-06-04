[CmdletBinding()]
param(
    [string]$Version
)

$ErrorActionPreference = "Stop"

if (-not $Version) {
    throw "Version parameter is required. Example: pwsh -File scripts/gh_release.ps1 -Version v0.1.1"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$cleanVer = $Version.TrimStart('v')
$notes = @"
## AI Coding Proxy Gateway v$cleanVer

### 주요 변경 사항
- 어드민 API에 업스트림 프로바이더 삭제 기능 추가 (`DELETE /admin/providers/{name}`)
- `/v1/models` GET 엔드포인트에 대한 Proxy Key 인증 예외 적용 (인증 없이 조회 가능)
- 클라이언트가 직접 Upstream API Key (`sk-...` 등)를 보낼 때 Proxy Key DB에 일치하지 않아도 통과(Passthrough) 처리하도록 프록시 로직 개선
- 업스트림 프로바이더 삭제 API에 대한 테스트 추가 및 통합 검증 완료

### 배포 파일
| 파일 | 설명 |
|------|------|
| ``ai-coding-proxy-gateway-v$cleanVer.tar.gz`` | Docker 이미지 패키지 (linux/amd64) |
| ``ai-coding-proxy-gateway-v$cleanVer.tar.gz.sha256`` | SHA256 체크섬 |
| ``README-offline-v$cleanVer.md`` | 오프라인 배포 가이드 |

### 빠른 시작
```bash
# 이미지 로드
gunzip -c ai-coding-proxy-gateway-$Version.tar.gz | docker load

# 실행
docker run -d --name proxy-gateway --restart=always \
  -p 8080:8080 \
  -v /opt/proxy-gateway/data:/data \
  -e UPSTREAM_BASE_URL=https://api.openai.com \
  -e UPSTREAM_API_KEY=sk-... \
  -e ADMIN_TOKEN=change-me \
  ai-coding-proxy-gateway:$Version
```
"@

gh release create $Version `
  "release\ai-coding-proxy-gateway-$Version.tar.gz" `
  "release\ai-coding-proxy-gateway-$Version.tar.gz.sha256" `
  "release\README-offline-$Version.md" `
  --repo hkjang/vibe-coders `
  --title "$Version - AI Coding Proxy Gateway" `
  --notes $notes

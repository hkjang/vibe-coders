$notes = @"
## AI Coding Proxy Gateway v0.1.0

### 주요 기능
- OpenAI 호환 API 프록시 게이트웨이
- SQLite / PostgreSQL 지원
- 사용자별 API 키 관리 및 할당량(Quota) 제어
- 토큰 사용량 실시간 모니터링 및 비용 추적 (KRW)
- 관리자 웹 UI (/admin)
- 오프라인(폐쇄망) 배포 지원

### 배포 파일
| 파일 | 설명 |
|------|------|
| ``ai-coding-proxy-gateway-v0.1.0.tar.gz`` | Docker 이미지 패키지 (linux/amd64) |
| ``ai-coding-proxy-gateway-v0.1.0.tar.gz.sha256`` | SHA256 체크섬 |
| ``README-offline-v0.1.0.md`` | 오프라인 배포 가이드 |

### 빠른 시작
```bash
# 이미지 로드
gunzip -c ai-coding-proxy-gateway-v0.1.0.tar.gz | docker load

# 실행
docker run -d --name proxy-gateway --restart=always \
  -p 8080:8080 \
  -v /opt/proxy-gateway/data:/data \
  -e UPSTREAM_BASE_URL=https://api.openai.com \
  -e UPSTREAM_API_KEY=sk-... \
  -e ADMIN_TOKEN=change-me \
  ai-coding-proxy-gateway:v0.1.0
```
"@

gh release create v0.1.0 `
  "release\ai-coding-proxy-gateway-v0.1.0.tar.gz" `
  "release\ai-coding-proxy-gateway-v0.1.0.tar.gz.sha256" `
  "release\README-offline-v0.1.0.md" `
  --repo hkjang/vibe-coders `
  --title "v0.1.0 - AI Coding Proxy Gateway" `
  --notes $notes

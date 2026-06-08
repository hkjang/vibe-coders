# AI Coding Proxy Gateway - PostgreSQL 연동 및 기동 가이드

본 가이드는 AI Coding Proxy Gateway의 메인 데이터베이스를 기본 SQLite에서 PostgreSQL로 변경하여 운영 환경(특히 다중 인스턴스 이중화/HA 환경)을 구성하고 기동하는 방법을 설명합니다.

---

## 1. 개요 및 지원 방식

AI Coding Proxy Gateway는 Go 표준 데이터베이스 라이브러리(`database/sql`)와 `jackc/pgx/v5/stdlib` 드라이버를 통해 PostgreSQL을 완벽하게 지원합니다.
* **자동 감지**: 환경변수 `POSTGRES_DSN` 또는 `DATABASE_URL`에 `postgres://` 또는 `postgresql://` 프로토콜 스키마가 포함되어 있으면 데이터베이스 드라이버가 자동으로 PostgreSQL로 전환됩니다.
* **수동 설정**: `DB_DRIVER=postgres` 및 `DB_DSN` 환경변수를 사용하여 연결 정보를 명시할 수도 있습니다.
* **자동 스키마 마이그레이션**: Gateway 기동 시 필요한 테이블(`api_keys`, `request_logs` 등)이 자동으로 생성되므로, 비어있는 데이터베이스만 미리 준비해두면 됩니다.

---

## 2. 환경 변수 설정

PostgreSQL 연결을 위해 아래의 환경 변수 중 하나를 구성해야 합니다.

### 방법 A: `POSTGRES_DSN` 또는 `DATABASE_URL` 사용 (권장 - 자동 감지)
* **`POSTGRES_DSN`**: `postgres://[사용자명]:[비밀번호]@[호스트]:[포트]/[DB명]?sslmode=disable`
* **`DATABASE_URL`**: 동일한 포맷을 가지며, 클라우드 환경(Heroku, Render 등)과 호환됩니다.

### 방법 B: `DB_DRIVER` 및 `DB_DSN` 사용 (명시적 설정)
* **`DB_DRIVER`**: `postgres` (또는 `postgresql`)
* **`DB_DSN`**: `postgres://[사용자명]:[비밀번호]@[호스트]:[포트]/[DB명]?sslmode=disable`

> [!TIP]
> SSL을 사용하지 않는 인트라넷/로컬 환경에서는 연결 문자열 끝에 `?sslmode=disable` 매개변수를 반드시 추가해야 접속 오류를 방지할 수 있습니다.

---

## 3. 로컬 기동 가이드

로컬 개발 환경 또는 가상머신(VM)에서 PostgreSQL을 메인 DB로 사용하여 서비스를 기동하는 방법입니다.

### 3.1 PostgreSQL 데이터베이스 생성
먼저 PostgreSQL에 접속하여 사용할 데이터베이스를 생성합니다.
```sql
CREATE DATABASE gateway_db;
```

### 3.2 게이트웨이 빌드 및 실행
환경변수를 주입하고 `gateway` 애플리케이션을 구동합니다.

#### Windows (PowerShell)
```powershell
# 환경변수 설정
$env:POSTGRES_DSN="postgres://postgres:password@localhost:5432/gateway_db?sslmode=disable"
$env:UPSTREAM_BASE_URL="https://api.openai.com"
$env:UPSTREAM_API_KEY="sk-..."
$env:ADMIN_TOKEN="your-secure-admin-token"

# 실행
go run ./cmd/gateway
```

#### Linux / macOS (Bash)
```bash
# 환경변수 설정 및 실행
export POSTGRES_DSN="postgres://postgres:password@localhost:5432/gateway_db?sslmode=disable"
export UPSTREAM_BASE_URL="https://api.openai.com"
export UPSTREAM_API_KEY="sk-..."
export ADMIN_TOKEN="your-secure-admin-token"

go run ./cmd/gateway
```

---

## 4. Docker Compose 연동 및 기동 가이드

PostgreSQL 컨테이너와 Gateway 컨테이너를 Docker Compose를 통해 패키징하여 함께 구동하는 가장 표준적인 구성 예시입니다.

### 4.1 `docker-compose.yml` 작성
워크스페이스 폴더 또는 배포 폴더에 `docker-compose.postgres.yml` 등의 이름으로 설정을 구성합니다.

```yaml
version: '3.8'

services:
  # 1. PostgreSQL 데이터베이스 서비스
  postgres-db:
    image: postgres:15-alpine
    container_name: gateway-postgres
    restart: always
    environment:
      POSTGRES_USER: gateway_user
      POSTGRES_PASSWORD: gateway_password_123
      POSTGRES_DB: gateway_db
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gateway_user -d gateway_db"]
      interval: 5s
      timeout: 5s
      retries: 5

  # 2. AI Coding Proxy Gateway 서비스
  gateway:
    image: ai-coding-proxy-gateway:v0.1.5
    container_name: proxy-gateway
    restart: always
    ports:
      - "8080:8080"
    depends_on:
      postgres-db:
        condition: service_healthy
    environment:
      - UPSTREAM_BASE_URL=https://api.openai.com
      - UPSTREAM_API_KEY=sk-...
      - ADMIN_TOKEN=change-me-to-secure-token
      - GATEWAY_SECRET=encryption-key-must-be-32-bytes-long! # API 키 암호화용 32바이트 키
      # Postgres 연결 설정 (서비스 이름 'postgres-db'를 호스트명으로 사용)
      - POSTGRES_DSN=postgres://gateway_user:gateway_password_123@postgres-db:5432/gateway_db?sslmode=disable
    volumes:
      # 설정 파일 보관용 볼륨 마운트 (SQLite 미사용으로 DB 파일은 생성되지 않음)
      - ./data:/data

volumes:
  postgres_data:
```

### 4.2 서비스 기동
작성된 Docker Compose 설정을 이용해 백그라운드로 구동합니다.
```bash
docker compose -f docker-compose.postgres.yml up -d
```

### 4.3 헬스체크 및 기동 확인
컨테이너 로그 및 Gateway 상태를 점검합니다.
```bash
# 로그 확인
docker compose -f docker-compose.postgres.yml logs -f gateway

# 서비스 헬스체크 호출
curl -fsS http://localhost:8080/ready
```

---

## 5. 다중 인스턴스 구성 (HA / Load Balancing)

메인 DB로 PostgreSQL을 사용하면, 대용량 트래픽 대응 및 고가용성(HA)을 위해 여러 개의 Gateway 컨테이너 인스턴스를 수평 확장(Scale-out)할 수 있습니다.

```mermaid
graph TD
    Client[개발자/IDE 클라이언트] --> LB[로드 밸런서 (Nginx/HAProxy)]
    LB --> GW1[Gateway Instance 1]
    LB --> GW2[Gateway Instance 2]
    LB --> GW3[Gateway Instance 3]
    GW1 --> DB[(공통 PostgreSQL DB)]
    GW2 --> DB
    GW3 --> DB
```

### 주의 및 권장사항
1. **`GATEWAY_SECRET` 동기화**: 모든 Gateway 인스턴스들은 동일한 `GATEWAY_SECRET` (API 키 양방향 암호화에 사용되는 32바이트 대칭키)을 공유해야 합니다. 서로 다르면 A 인스턴스에서 등록한 업스트림 API 키를 B 인스턴스에서 조회할 때 복호화에 실패합니다.
2. **커넥션 풀 구성**: `sqlstore.go`에서 기본 설정된 Max Open Connection은 **25**입니다. 인스턴스가 다수 증가하는 경우 Postgres DB 서버의 `max_connections` 한도를 적절히 늘려주어야 합니다.

---

## 6. 백업 및 복구 가이드 (PostgreSQL)

SQLite와 달리 단일 DB 파일 복사 방식이 아닌, PostgreSQL의 표준 유틸리티를 활용하여 데이터를 관리해야 합니다.

### 6.1 데이터베이스 백업
```bash
# Docker Compose 환경에서 백업 파일 추출
docker exec -t gateway-postgres pg_dump -U gateway_user -d gateway_db > backup_gateway_$(date +%Y%m%d).sql
```

### 6.2 데이터베이스 복구
```bash
# 복구 대상 데이터베이스 초기화 및 적용
docker exec -i gateway-postgres psql -U gateway_user -d gateway_db < backup_gateway_YYYYMMDD.sql
```

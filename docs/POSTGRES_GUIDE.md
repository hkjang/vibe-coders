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

## 4. 기동 가이드

기동 환경 및 데이터베이스 구성에 따라 아래의 방식을 선택합니다.

### 4.1 Docker Compose (DB 컨테이너와 Gateway 동시 기동)

PostgreSQL 컨테이너와 Gateway 컨테이너를 Docker Compose를 통해 패키징하여 함께 구동하는 단일 테스트/운영 구성 예시입니다.

#### 4.1.1 `docker-compose.postgres.yml` 작성
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
    image: ai-coding-proxy-gateway:v0.1.6
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

#### 4.1.2 서비스 기동
작성된 Docker Compose 설정을 이용해 백그라운드로 구동합니다.
```bash
docker compose -f docker-compose.postgres.yml up -d
```

#### 4.1.3 헬스체크 및 기동 확인
컨테이너 로그 및 Gateway 상태를 점검합니다.
```bash
# 로그 확인
docker compose -f docker-compose.postgres.yml logs -f gateway

# 서비스 헬스체크 호출
curl -fsS http://localhost:8080/ready
```

---

### 4.2 기존 외부 PostgreSQL VM 서버 연동 기동 (실운영 권장)

이미 인프라 내에 구축되어 있는 **독립된 PostgreSQL VM 서버** 또는 **RDS(클라우드 DB)** 인스턴스를 메인 데이터베이스로 사용하고, Gateway 서비스만 단독으로 실행하여 연동하는 가이드입니다.

#### 4.2.1 PostgreSQL VM 서버 사전 설정
외부 대역(Gateway가 구동 중인 서버/컨테이너)에서 PostgreSQL에 접속할 수 있도록 VM 내부의 접근 제어 설정을 확인해야 합니다.

1. **외부 접근 설정 허용 (`postgresql.conf`)**
   PostgreSQL이 루프백(`localhost`) 외에 외부 네트워크 대역에서도 연결을 대기하도록 변경합니다.
   ```ini
   # /etc/postgresql/15/main/postgresql.conf (설치 환경에 따라 경로 상이)
   listen_addresses = '*'
   ```

2. **클라이언트 주소 허용 설정 (`pg_hba.conf`)**
   Gateway가 구동되는 서버의 IP 주소에 대해 접근 권한을 명시적으로 선언합니다.
   *(예: Gateway 서비스가 돌아가는 서버 IP가 `192.168.10.50`인 경우)*
   ```ini
   # /etc/postgresql/15/main/pg_hba.conf
   # TYPE  DATABASE        USER            ADDRESS                 METHOD
   host    gateway_db      gateway_user    192.168.10.50/32        scram-sha-256
   ```
   *만약 특정 IP 대역 전체 또는 Docker 브리지 대역 전체를 열어두려면 `192.168.10.0/24` 형태로 주소를 지정하세요.*

3. **설정 적용 및 방화벽 오픈**
   PostgreSQL 서비스를 재구동하여 설정을 리로드하고, VM의 방화벽 포트(기본 5432)를 오픈합니다.
   ```bash
   sudo systemctl restart postgresql
   
   # Ubuntu UFW 방화벽 사용 시
   sudo ufw allow 5432/tcp
   ```

#### 4.2.2 Gateway 컨테이너 기동 설정 (`docker-compose.external.yml`)
별도의 내부 DB 컨테이너 없이 외부 VM을 다이렉트로 바라보도록 `docker-compose.external.yml`을 구성합니다.

```yaml
version: '3.8'

services:
  gateway:
    image: ai-coding-proxy-gateway:v0.1.6
    container_name: proxy-gateway
    restart: always
    ports:
      - "8080:8080"
    environment:
      - UPSTREAM_BASE_URL=https://api.openai.com
      - UPSTREAM_API_KEY=sk-...
      - ADMIN_TOKEN=change-me-to-secure-token
      - GATEWAY_SECRET=encryption-key-must-be-32-bytes-long!
      # 기존 외부 Postgres VM DB 연결 정보 지정 (192.168.10.20 VM 서버 예시)
      - POSTGRES_DSN=postgres://gateway_user:gateway_password_123@192.168.10.20:5432/gateway_db?sslmode=disable
    volumes:
      - ./data:/data
```

기동 명령어:
```bash
docker compose -f docker-compose.external.yml up -d
```

#### 4.2.3 네트워크 연동 테스트 팁
Gateway 구동 중 데이터베이스 연결 오류가 발생한다면, 게이트웨이 컨테이너 안에서 외부 Postgres VM 포트(5432)가 성공적으로 열려 있는지 테스트해볼 수 있습니다.
```bash
# nc 명령어를 이용한 포트 통신 검증
docker exec -it proxy-gateway nc -zv 192.168.10.20 5432

# nc가 없는 간이 환경인 경우 bash dev tcp 채널 검증
docker exec -it proxy-gateway bash -c "cat < /dev/tcp/192.168.10.20/5432"
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
# 1. 내부 Docker 컨테이너 DB인 경우
docker exec -t gateway-postgres pg_dump -U gateway_user -d gateway_db > backup_gateway_$(date +%Y%m%d).sql

# 2. 외부 Postgres VM 서버인 경우 (로컬 PC 또는 Gateway 서버에서 원격 백업)
pg_dump -h 192.168.10.20 -p 5432 -U gateway_user -d gateway_db > backup_gateway_$(date +%Y%m%d).sql
```

### 6.2 데이터베이스 복구
```bash
# 1. 내부 Docker 컨테이너 DB인 경우 복구
docker exec -i gateway-postgres psql -U gateway_user -d gateway_db < backup_gateway_YYYYMMDD.sql

# 2. 외부 Postgres VM 서버인 경우 복구
psql -h 192.168.10.20 -p 5432 -U gateway_user -d gateway_db < backup_gateway_YYYYMMDD.sql
```

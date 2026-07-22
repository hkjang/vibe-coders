# Third-party licenses

이 문서는 `go list -deps ./cmd/gateway`가 보고한 **게이트웨이 실행 바이너리의
빌드 의존성**을 `go.mod`/`go.sum`의 고정 버전과 대조해 작성했습니다. 전체
라이선스 원문과 저작권 표시는 각 모듈 배포본의 `LICENSE*` 파일을 따릅니다.
검토 기준일은 2026-07-22입니다.

| 구성요소 | 버전 | 라이선스 | 용도 |
| --- | --- | --- | --- |
| `filippo.io/edwards25519` | v1.2.0 | BSD-3-Clause | 암호 연산 지원 |
| `github.com/dustin/go-humanize` | v1.0.1 | MIT | 사람이 읽기 쉬운 값 표시 |
| `github.com/go-sql-driver/mysql` | v1.10.0 | MPL-2.0 | MySQL 드라이버 |
| `github.com/google/uuid` | v1.6.0 | BSD-3-Clause | UUID 생성·처리 |
| `github.com/jackc/pgpassfile` | v1.0.0 | MIT | PostgreSQL passfile 처리 |
| `github.com/jackc/pgservicefile` | v0.0.0-20240606120523-5a60cdf6a761 | MIT | PostgreSQL service file 처리 |
| `github.com/jackc/pgx/v5` | v5.7.6 | MIT | PostgreSQL 드라이버 |
| `github.com/jackc/puddle/v2` | v2.2.2 | MIT | 연결 풀 |
| `github.com/remyoudompheng/bigfft` | v0.0.0-20230129092748-24d4a6f8daec | BSD-3-Clause | SQLite 수치 연산 지원 |
| `github.com/sijms/go-ora/v2` | v2.9.0 | MIT | Oracle 드라이버 |
| `golang.org/x/crypto` | v0.37.0 | BSD-3-Clause | 암호 기능 |
| `golang.org/x/sync` | v0.13.0 | BSD-3-Clause | 동시성 유틸리티 |
| `golang.org/x/sys` | v0.42.0 | BSD-3-Clause | 운영체제 인터페이스 |
| `golang.org/x/text` | v0.24.0 | BSD-3-Clause | 텍스트·문자 인코딩 |
| `modernc.org/libc` | v1.55.3 | BSD-3-Clause | 순수 Go libc 호환 계층 |
| `modernc.org/mathutil` | v1.6.0 | BSD-3-Clause | 수학 유틸리티 |
| `modernc.org/memory` | v1.8.0 | BSD-3-Clause | 메모리 관리 지원 |
| `modernc.org/sqlite` | v1.34.5 | BSD-3-Clause | 순수 Go SQLite 드라이버 |

## 프레임워크, 모델, 데이터

- 별도 웹 프레임워크는 사용하지 않으며 Go 표준 라이브러리의 `net/http`를
  중심으로 구현되어 있습니다. Go 표준 배포물은 BSD-3-Clause입니다.
- 저장소와 게이트웨이 바이너리에는 LLM 가중치가 포함되지 않습니다. OpenAI,
  Anthropic, Gemini, Ollama, vLLM 등 운영자가 설정한 OpenAI 호환 서비스로
  요청을 중계합니다. 각 모델의 API 약관·출력물 정책·라이선스 준수 책임은
  해당 서비스를 선택하고 자격 증명을 제공한 운영자에게 있습니다.
- 학습, 파인튜닝, 벤치마크용 외부 데이터셋은 포함되어 있지 않습니다.
  `seed.sql`은 애플리케이션 구동용 예시/초기 데이터이며 프로젝트의
  AGPL-3.0-only 적용 범위에 포함됩니다.

## 컨테이너 이미지

`Dockerfile`은 빌드 시 `golang:1.26-alpine`, 실행 시
`gcr.io/distroless/static:nonroot`를 사용합니다. 태그만으로는 이미지 내용이
변할 수 있으므로 릴리스 시 digest로 고정하고 최종 이미지 자체를 다시
스캔해야 합니다. 루트의 `SBOM.spdx.json`은 Go 소스 빌드 의존성 SBOM이며
컨테이너 운영체제 계층의 완전한 SBOM을 주장하지 않습니다.

## 재검증

```bash
go mod verify
go list -deps -json ./cmd/gateway
go test ./...
```

실제 재배포 전에는 각 모듈 캐시의 `LICENSE*` 원문과
`SBOM.spdx.json`을 함께 검토하십시오. 이 목록은 법률 자문이 아닙니다.

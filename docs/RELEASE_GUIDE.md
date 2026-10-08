# 릴리즈 가이드 (Release Guide)

AI 코딩 프록시 게이트웨이의 빌드·태깅·GitHub 릴리즈·오프라인 배포 패키지 산출 절차를 한 문서에 정리했습니다.

현재 일반 명령 예시는 게시된 `v0.86.40`과 그 직전 릴리즈 `v0.86.39`의 절차를 따릅니다.
이 예시로 게시된 태그를 다시 만들거나 후보 소스를 이전 버전으로 포장하지 마세요.
최신 확인 출고는 [`v0.86.45`](https://github.com/hkjang/vibe-coders/releases/tag/v0.86.45)입니다.
정확한 메인 CI·태그·최종 이미지와 공개 파일 검증을 마쳤습니다. 후보 버전 파일 변경만으로
게시 완료를 판단하지 않으며 이미 게시된 태그를 다시 만들지 않습니다.

다음 `v0.86.46` 후보는 LLM 조회 소유자 격리·거부 후 초안 복구·늦은 피드백 응답 보호입니다.
v45의 메인 CI와 공개 파일 검증은 완료했지만 v46 출고에는 새 버전 `v0.86.46`과 직전 버전
`v0.86.45`를 명시하고 정확한 후보·메인 CI와 정식 태그 이미지·공개 파일을 새로 검증합니다.
이전 버전이나 중간 후보의 통과 결과를 최종 생성물의 출고 증거로 재사용하지 않습니다.

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
- [ ] React 브라우저 검사 전체가 첫 시도에 통과. CI는 진단용 재시도 1회를 유지하지만, 재시도로만 통과한 검사가 있으면 실패 처리하고 최초 실패 자료를 보존
- [ ] 현재 마일스톤의 합성 브라우저·구성요소와 별도 실제 Go HTTP·SQLite/PostgreSQL 검사를 구분해 기록. 이전 버전이나 중간 소스의 통과를 최종 후보 빌드·원격 CI로 대체하지 않음
- [ ] `web/dist/index.html`과 hashed `web/dist/assets/*` 생성 확인
- [ ] v0.80.0 이상은 Go+npm 통합 `SBOM.spdx.json`과 Frontend 포함 `THIRD_PARTY_LICENSES.md` 갱신
- [ ] 최종 이미지 `scripts/container-smoke.sh` 검증 통과
- [ ] `CHANGELOG` 또는 커밋 메시지에 변경사항 정리
- [ ] `GATEWAY_SECRET` 운영 값으로 설정 확인 (기본 개발값 절대 금지)
- [ ] `ADMIN_TOKEN` 설정 여부 확인
- [ ] Docker `proxy-gateway-data` volume과 0600 `gateway.env` 백업 및 `.sha256` 검증 완료
- [ ] GitHub 원격 저장소 접근 권한 확인 (`gh auth status`)

### v0.86.46 후보의 별도 확인 범위

LLM 목록·상세·비교·관련 요청/메모의 조회 소유자 분리와 최종 읽기 거부 시 이전 표시의 폐기를
확인합니다. 같은 소유자의 명시적 재조회·동일 요청의 새 상세/메모 확인 뒤 사용자 초안만 복구하며,
다른 소유자나 이미 전송한 편집을 자동 재전송하지 않습니다. 같은 현재 조회 수명의 일반 피드백
오류는 중복 가능성을 한글로 안내한 뒤 수동 재시도만 허용합니다. 기존 `/admin`·서버 업무 API·
RBAC와 다른 메모 호출자의 기본 정책은 유지합니다.

최초 전체 브라우저 907 PASS/3 FAIL과 배포 기본 버전 불일치를 보존하고 수정했습니다.
수정본 전체 UI 3,759개/254파일·Node 53개·고정 브라우저 910개/44파일, 정적 6단계·빌드·
예산·OpenAPI 468경로·SBOM/라이선스 재현을 통과했습니다. 같은 내장 UI의 Go 일반 2,605개·
레이스 2,588개 test/subtest events, 기존 관리자 18개·vet·빌드·API 표면, 격리 PostgreSQL
LLM 7개/메모 39개, 실제 Go/로컬 OIDC 인증 11개/공급자 1개 및 사전 nonroot 컨테이너도
통과했습니다. PostgreSQL 준비 단계 실패와 별도 TCP 준비 보완은 제품 검사 결과와 구분합니다.
정확한 범위·선택형 생략·최초 실패는 [인수 검증표](APP_UI_ACCEPTANCE.md)를 따릅니다.

로컬 검증 후 원격 PR/메인 CI, 같은 메인의 주석 태그, 새 정식 이미지 및 공개 7종의 실제 다운로드
검증이 남습니다. 운영 배포·Stable 승격·Phase 0–6 전체 인수 완료를 뜻하지 않습니다.

```powershell
# 후보 절차 예시이며 정확한 최종 게이트 통과 전에는 실행하지 않는다.
pwsh -File scripts/gh_release.ps1 -Version v0.86.46 -PrevVersion v0.86.45
```

### v0.86.45 출고 및 이전 후보의 확인 기록

보완본 `10c7a3ea`의 전체 UI 3,686개·고정 브라우저 904개와 서버·실제 인증 검증, PR #75의
정확한 CI를 통과한 뒤 메인 `58a202ed52ce941f46fa7fc107916874a3554b83`으로 정상 병합했습니다.
메인 CI 37724034290 10개·Pages 3개도 통과한 뒤 같은 소스에 annotated 태그를 붙였습니다.
공식 스크립트의 정식 이미지·화면 구동·High/Critical 게이트와 공개 파일 7종의 새 다운로드 검증,
`verify_release.sh v0.86.45`까지 통과했습니다. 공개 릴리즈 ID는 406404299이며 게시 시각은
2026-10-08 04:13:01 UTC입니다. 아래는 추가 P1 보완 이전의 최초 검증·보류 이력입니다.

XView의 상대 구간 정리·빈 응답의 수신 시각·6,000건 표본 상한·P95와 한글 실시간 상태를
검증합니다. 기존 커서·보완 GET 계약을 유지하며 커서 정체/순환의 빠른 연속 요청을 제한합니다.
일반 갱신·503·구간 만료와 최종 401/403의 자료 수명을 구분하고, 같은 소유자의 명시적
재조회·동일 요청 재선택·최신 메모 확인 뒤에만 작성 초안을 복구하는 흐름을 검사합니다.
XView opt-in 메모 PATCH/DELETE는 401 인증 재시도에 따른 자동 재전송을 끕니다. 이미 보낸
초안의 늦은 응답과 재전송 잠금도 확인하되 다른 요청/LLM 호출자의 기본 동작은 유지합니다.

원본 구간 만료·시각·상한·P95 실패, 숨겨진 초안에 접근할 수 없는 실패, 두 인증 분기에서
발생한 실제 ApiClient 자동 PATCH 재전송 실패를 보존했습니다. 예비 UI 표시 v44의 집중
541개·독립 47개·합성 브라우저 12개와 타입·범위 린트·빌드가 통과했습니다. 이후 최종 v45로
전체 UI 3,681개·Node 53개·고정 브라우저 904개가 재시도·불안정 통과·생략 없이 통과했습니다.
정적 검사·빌드·성능 예산, 실제 OpenAPI 468경로와 SBOM/라이선스 재현도 통과했습니다.
Go 일반 2,605개·내부 레이스 2,588개 test/subtest events(선택형 12개 생략), 기존 관리자
18개, vet·빌드·API 표면, 격리 PostgreSQL XView 35개·요청 메모 39개, 실제 인증 11개·
공급자 1개 검사를 통과했습니다. PostgreSQL 정리 확인의 비동기 시점, 빈 브라우저 결과 디렉터리,
컨테이너 결과 파일 소유권 문제는 최초 실행 도구 실패로 보존했고 제품 검사를 다시 실행하지
않고 해당 준비·정리·결과 접근만 확인했습니다. 상세 기록은 인수 검증표를 따릅니다.
후보 사전 컨테이너의 nonroot 실행·기존 관리자/신규 화면 구동·Grype High/Critical 차단 검사도
통과했고 소스와 내장 141개 파일은 전후 동일합니다. 사전 이미지는 정식 태그 이미지가 아닙니다.
정확한 원격 CI·태그 이미지와 공개 파일 검증은 별도로 남습니다.
처음 실패한 테스트를 단순 재실행으로 통과 처리하지 않으며 자세한 이력은 인수 검증표에 기록합니다.

위 로컬 기록은 초기 후보 `5259104dcebc0569fc2ef69e841d97b884ff8c50`의 결과입니다.
해당 PR CI `37718906469` 10개 작업과 Golden `37718906464`도 통과했지만,
[PR #75 상세 캐시 리뷰](https://github.com/hkjang/vibe-coders/pull/75#discussion_r4214067295)에서
제기된 문제가 실제 인증 갱신 경로로 재현돼 병합·출고를 보류했습니다. 같은 세션의 원문 권한·
사용자·팀 변경 뒤 과거 상세를 다시 표시하는 3개 실패와 정상 대조군을 보존했습니다.
XView에 한정한 조회 소유자별 키·정확한 캐시 폐기·늦은 응답 보호를 추가했으며 집중 회귀와
타입·린트는 통과했습니다. 초기 후보의 전체 통과를 이 보완본의 통과로 대체하지 않습니다.
수정본의 전체 프런트엔드·내장 화면/인증·정확한 CI 및 출고 검증을 다시 확인해야 합니다.
기존 LLM 관측 화면은 부모 조회까지 별도 보완이 필요하므로 이번 수정의 보호 범위에 포함하지 않습니다.

```powershell
# 이미 게시한 v45의 절차 기록이며 재실행하지 않는다.
pwsh -File scripts/gh_release.ps1 -Version v0.86.45 -PrevVersion v0.86.44
```

### v0.86.44 출고 및 이전 후보의 확인 기록

읽기 전용 도메인 결정 근거 탐색이 대상입니다. 한글 요청 ID 필터·기록과 근거 상세·수신
시각·제한 목록 안내, 권한과 현재 조회 수명·401/403 데이터 폐기·명시적 복구를 검증합니다.
최종 v44 UI 3,625개·Node 53개·고정 브라우저 892개와 정적/빌드, 실제 Go 일반/레이스·
기존 관리자·인증/공급자·격리 PostgreSQL·OpenAPI·SBOM 재현·사전 컨테이너를 통과했습니다.
최초 실패와 정확한 범위는 인수 검증표에 보존합니다. PR #74의 CI와 메인
`3b72f4df1cd1860875aacff337c5ae6673bfb4db`의 CI `37713653405` 10개 작업이 통과한 뒤
annotated tag를 생성·푸시했습니다. 해당 소스의 정식 이미지 기동과 Grype 0.117.0 검사를
통과했고 2026-10-08 02:04:34 UTC 공개했습니다. 릴리스 ID는 `406331939`이며 초안·게시 직전·
공개 후 배포 파일 7종을 각각 다시 내려받아 크기·API 해시·manifest·태그 소스와 대조했습니다.
`scripts/verify_release.sh v0.86.44`도 통과했습니다. 이미지 검사 통과가 호출되지 않는 모든
Go 모듈의 취약점 부재나 운영 Stable 승격을 뜻하지 않습니다.

압축 이미지 SHA-256은 `4b7054a40e63a75f8b6e250e603bdef4c5d9f7987e40183a1fd03510553f0885`
이며 13,020,359바이트입니다. 게시된 태그나 자산을 다시 덮어쓰지 마세요. 다음 후보의 출고는
별도 게이트와 새 태그를 사용합니다.

### v0.86.43 출고 및 이전 후보의 확인 기록

도메인 검토 큐의 한글 승인·거절 검토와 실제 상태 기록 의미가 대상입니다. 현재 권한·세션·
조회/선택 수명, 정확한 본문 없는 ID/action 전송과 ACK, 미확정 결과의 같은 창 잠금 및
조회만 복구하는 흐름을 검증합니다. 성공 DTO의 query_text 제외뿐 아니라 오류 원문의
상태/캐시 유입도 막고 전용 POST의 자동 401 재전송을 끕니다. 원문 GET 전송·서버 권한,
반복·없는 ID 200·status/reviewed_at 변경·best-effort 감사는 기존 계약대로 유지합니다.
CAS·멱등성·원자적 감사·학습 예시 승격·라우팅 규칙 변경이나 운영 Stable 완료가 아닙니다.

- [x] 기존 UI 독립 대조 14개: 정상 2개 통과·실질 실패 12개와 최초 근거 보존.
- [x] 중간 후보 구성요소 36개·실제 Go/SQLite·명세 집중 상위 9개·전용 합성 브라우저 14개 통과 기록.
- [x] 오류 투영·자동 401 재전송 보완을 포함한 최종 집중 83개·전체 UI 3,497개·고정 브라우저 875개.
- [x] v43 실제 OpenAPI 내보내기·정규 생성 대조·빌드/내장 에셋·SBOM/라이선스 생성.
- [x] 의존성 보완 뒤 전체 Go 정상/레이스·vet·빌드·실제 인증/공급자·PostgreSQL·사전 컨테이너와 입력 해시 대조.
- [x] 정확한 커밋의 PR/메인 CI·주석 태그·최종 이미지·공개 파일 실제 다운로드 및 v43 게시.

첫 PR #72의 `89569e80`은 CI `37703445013`의 GO-2026-6629 검사 실패로 병합을 보류했다.
x/text 0.41.0과 필수 x/sync 0.22.0 보완 뒤 새 커밋의 모든 게이트를 통과해야 한다.
로컬 govulncheck의 호출 경로 영향 0건과 미호출 모듈 수준 4건은 구분한다.

후속 후보는 PR 검사를 통과해 #72로 병합했지만, 출고 전 GET 403 이후 이전 검토 내용을
계속 표시하는 독립 회귀가 확인되어 태그·게시를 다시 보류했다. 읽기 거부 시 해당 조회·열린
창·동의 수명을 폐기하는 보완의 정확한 PR/메인 CI와 브라우저 검사를 새로 통과해야 한다.
기존 녹색 검사나 메인 병합만으로 이 보류를 해제하지 않는다. 후속 보완 `5975498e`의
로컬 UI 3,506개·고정 브라우저 876개, PR #73 CI `37707706311`, 병합 메인 `7f90ab6a`의
push CI `37709615977` 10개 작업을 별도로 통과한 뒤에 보류를 해제했다. 해당 메인의
주석 태그 v0.86.43과 공식 release.sh 최종 이미지·구동·Grype 검사를 통과했다.
이 환경에는 pwsh가 없어 gh CLI로 같은 소스/CI/태그·초안 다운로드 검증을 수행한 뒤 공개했다.
비공개 초안은 태그별 REST 조회가 404여서 목록에서 ID `406302569`를 확인하고 ID별로
조회했으며, 자산을 재업로드하거나 검증을 생략하지 않았다. 공개 뒤에도 7개 파일을 새로
내려받아 API digest/크기·6개 payload 체크섬·태그의 원본 자산을 대조하고 표준
verify_release.sh를 통과했다. 게시 시각은 2026-10-08 01:12:16 UTC다.

```powershell
# 이미 게시한 v43의 절차 기록이며 재실행하지 않는다.
pwsh -File scripts/gh_release.ps1 -Version v0.86.43 -PrevVersion v0.86.42
```

### v0.86.42 출고 및 이전 후보의 확인 기록

[v42 공개 릴리즈](https://github.com/hkjang/vibe-coders/releases/tag/v0.86.42)는 게시됐습니다.
아래 로컬 후보 검사는 후속 인증 CI 실패·보완·게시와 구분한 기록이며 개별 실행 식별자와
최초 실패는 인수 검증표를 따릅니다. 공개 게시 사실로 과거 실패를 성공으로 바꾸지 않습니다.

학습 추천에서 활성 라우팅 규칙을 만드는 한글 검토·작업 유형 비제한 영향 확인이 대상입니다.
서버의 복잡도 경계와 관측 표본 의미를 맞추며 현재 추천/권한/세션 기준, 엄격한 생성 응답과
미확정 결과의 같은 창 재전송 잠금을 검증합니다. 기존 자동 학습·도메인 승인·다른 규칙 작업,
서버 업무 구현과 기존 관리자를 유지합니다. 전체 영향·멱등성·Stable 완료를 뜻하지 않습니다.

- [x] 기존 UI 정상 대조 1개·실질 실패 7개, 엄격 API 단위 49개와 실제 Go/SQLite 계약·명세 정상/레이스 검증.
- [x] 실제 기본 v42 바이너리 OpenAPI 내보내기·정규 타입 생성·468경로 및 승인한 차이만 대조.
- [x] 최종 UI 3,354개/222파일·Node 45개(선택 실행 3개 건너뜀), 합성 브라우저 858개/39파일(재시도 0), 140개 빌드/내장 파일 일치 및 격리 PostgreSQL 계약 정상/레이스 검사.
- [x] 실제 격리 인증 11개·공급자 1개·보고서 보호 16개, 통합 SBOM/라이선스 재현 및 후보 컨테이너 검사.
- [x] 전체 Go 정상 2,537개·내부 레이스 2,520개(각 선택 실행 12개 건너뜀), 기존 관리자 15개·vet·빌드·API 감사 및 최종 동결 입력 대조.
- [x] 후속 인증 보완 PR #71 병합과 v42 공개 게시 확인. 개별 최종 산출물의 상세 근거는 게시 사실과 별도로 대조합니다.

```powershell
# 게시된 v42 절차의 기록이다. 같은 버전을 다시 게시하지 않는다.
pwsh -File scripts/gh_release.ps1 -Version v0.86.42 -PrevVersion v0.86.41
```

### v0.86.41 출고 확인 범위

라우팅 규칙 추가의 한글 검토·사용 중 영향 확인과 현재 권한·검토 수명 검증이 대상입니다.
미확정 생성은 같은 창에서 재전송하지 않고 확인된 요청 뒤 조회 실패는 별도로 복구합니다.
기존 POST 업무 구현·학습 추천·인증·관리자는 유지하며 멱등 생성이나 전체 영향 검증을 뜻하지 않습니다.

- [x] 기존 UI의 실질 실패 4개와 정상 대조 1개, 초점 2개 실패 재현 및 수정 후 상태 34개·안전 검사 34개·기존 화면 17개.
- [x] 실제 생성 HTTP/OpenAPI 계약 및 SQLite·격리 PostgreSQL 정상/레이스 검증.
- [x] 최종 UI 3,224개/219파일·Node 45개(선택 실행 3개 건너뜀)와 합성 브라우저 844개/38파일, 실제 인증 11개·공급자 1개·보고서 보호 16개, SBOM 재현·후보 컨테이너 검증.
- [x] 전체 Go 정상 2,490개/내부 레이스 2,473개 통과 기록(각 명시적 선택 실행 12개 건너뜀)·기존 관리자 15개·vet·빌드·API 감사 및 최종 동결 입력 대조.
- [x] PR #68·메인 CI/문서·같은 메인 주석 태그·최종 릴리즈 이미지와 공개 7개 파일 실제 다운로드. 식별자와 해시는 인수 검증표의 v41 출고 절 참고.

```powershell
# 완료된 v41 게시 명령의 기록이다. 같은 버전을 다시 게시하지 않는다.
pwsh -File scripts/gh_release.ps1 -Version v0.86.41 -PrevVersion v0.86.40
```

### v0.86.40 출고 확인 범위

라우팅 규칙 삭제의 고정 대상·한글 확인 문구·사용 중 영향 확인과 최신 권한/목록/원본 검증이
대상입니다. 미확정 응답은 같은 창의 재전송을 잠그고 확인된 응답 뒤 조회 실패를 구분합니다.
기존 DELETE는 없는 ID에도 성공 응답하므로 CAS·실제 한 행 삭제·정확히 한 번 실행을
보장하지 않습니다. 기존 생성/편집/사용 전환·인증·관리자와 서버 업무 구현을 유지합니다.

- [x] 실제 HTTP OpenAPI의 기존 DELETE·응답 스키마 1개·버전 변경, 468경로 유지와 표준 생성 대조.
- [x] 기존 화면의 권한/원본/표시 보호 실패를 독립 테스트로 재현하고 엄격 API 16개·registry 2개 확인.
- [x] 동결 입력의 전체 UI 단위 3,122개/216파일·Node 45개(선택 실행 3개 건너뜀), 정적 검사·빌드·예산과 내장 파일 정합. 양 DB 정상/레이스의 DELETE 계약은 각각 25개 통과 기록이며 전체 Go/브라우저와 구분한다.
- [x] 최종 UI 동결·전체 브라우저 830개/37파일·접근성, Go 정상 2,442개/내부 레이스 2,425개 통과 기록(각 선택 실행 12개 건너뜀), 양 DB·실제 인증 11개/공급자 1개/진단자료 보호 16개·후보 컨테이너 검증.
- [x] v40 SBOM/라이선스의 새 epoch 정규 생성·바이트 재현과 버전/생성물/내장 UI 정합. Go 미호출 모듈 취약점 4개·라이선스 NOASSERTION 47개는 전체 무취약/라이선스 적합성으로 바꾸지 않음.
- [x] PR #67·메인 `9a8e650f`의 CI/문서 배포·주석 태그 `cef59a4d`·정규 최종 이미지와 공개 7개 파일 실제 다운로드. 릴리즈 `401320192`의 상세 실행 ID·체크섬은 [인수 검증표](APP_UI_ACCEPTANCE.md)의 v40 출고 절을 따른다.

```powershell
# 완료한 v40 절차 기록이다. 게시된 태그를 다시 만들거나 덮어쓰지 않는다.
pwsh -File scripts/gh_release.ps1 -Version v0.86.40 -PrevVersion v0.86.39
```

### v0.86.39 출고 확인 범위

기존 라우팅 규칙의 7필드 한글 변경 검토·부분 저장과 기존 PATCH의 쓰기 시점 보호가 대상입니다.
아래는 완료한 로컬 검사와 후속 출고 기록이며,
후보 이미지 검사를 태그에 결속한 최종 릴리즈 이미지 검사로 합치지 않습니다.

- [x] SQLite/격리 PostgreSQL 정상·레이스 각각 신규 최상위 7개/하위 25개 및 기존 최상위 3개,
  두 패키지 vet. 삭제 후 재삽입·생략 값 덮기·이전 범위 사용의 최초 실패와 교정 근거 보존.
- [x] 별도 엄격 API 단위 35개·registry 2개와 Go OpenAPI 단위 1개. 실제 Go HTTP 명세
  468경로에서 버전·기존 GET/PATCH·4개 스키마 이외의 변화가 없는지 확인.
- [x] 최종 UI의 정상 저장·무변경·보호된 값 유지/명시 교체·잘못된 원본/응답 거부 검사.
- [x] 현재 권한/Query/검토 수명·미확정 재전송 잠금·확정 저장 후 조회 실패·dirty/초점·한글/
  390px 키보드 접근성 확인 및 기존 생성·삭제·사용 전환/Legacy 회귀.
- [x] v39 버전·실제 OpenAPI·생성물·SBOM/라이선스·빌드·내장 UI 정합과 전체 프런트엔드/Go
  정상·레이스/vet·실제 인증/공급자·보고서 보호·최종 후보 컨테이너 게이트.
- [x] PR #66·메인 `c1530695`의 CI/문서 배포와 주석 태그 `3db85185`, 정규 최종 이미지·공개 7종 실제 다운로드 검증. 릴리즈 `401244415`로 게시했으며 상세 실행 ID·체크섬과 독립 검토 범위는 [인수 검증표](APP_UI_ACCEPTANCE.md)의 v39 출고 절을 따른다.

전체 프런트엔드 3,075개/214파일·Node 45개 통과/선택 실행 3개 건너뜀과 정적 검사,
전체 합성 브라우저 816개/36파일·816번 시도 통과를 확인했다. 실제 인증 11개·공급자 업무
1개·보고서 보호 16개, 정규 SBOM/라이선스의 같은 epoch 재현·SDK/구성요소 검사와 별도
최종 후보 컨테이너의 nonroot·라우팅 직접 연결·기본 CSP·런타임 제외·image Grype도 통과했다.
초기 앱의 계산된 압축 전송 예산은 236,511바이트, 37경로이며 실제 네트워크 측정이 아니다.
전체 일반 Go 2,417개 기록/1,488개 최상위·12패키지, 내부 레이스 2,400개 기록/1,471개
최상위·9패키지가 통과했다(각 선택 실행 12개 건너뜀). vet·빌드·API 감사도 통과했다.
첫 실패·준비 오류·기존 테스트 교정은
[인수 검증표](APP_UI_ACCEPTANCE.md)의 v39 절처럼 최종 동결 실행과 분리한다.

원본 GET과 ACK의 알려진 10필드를 엄격히 확인하고 편집 가능한 7필드 중 변경분만 PATCH합니다.
UI의 무변경 요청 생략은 HTTP API의 `{}`/`null` 요청이 감사·캐시 등 부수 효과까지 없다는 뜻이 아닙니다.
v39 서버의 단일 부분 UPDATE는 PATCH 자체의 없는 ID 재삽입과 생략 값 덮기를 막고 현재 범위를
검사하지만, 명시적 같은 필드의 마지막 쓰기·외부 동일 ID 재생성·사전 GET 이후 경합은 남습니다.
저장 응답 유실 뒤 재조회만으로 요청 귀속을 증명할 수 없으며 기존 401 인증 갱신도 유지합니다.
활성 규칙은 실제 트래픽에 영향을 줄 수 있고 감사/설정된 후속 모의 검사는 비원자적이며 다른
pod의 5초 캐시 TTL도 유지합니다. 새 API·동시성 CAS·원자적 감사·전체 영향 검증·Stable 승격은 범위가 아닙니다.

다음은 v39 출고에 사용한 버전 인자 기록입니다. 이미 게시된 태그와 자산을 다시 만들거나 덮어쓰지 마세요.

```powershell
pwsh -File scripts/release.ps1 -Version v0.86.39
pwsh -File scripts/gh_release.ps1 -Version v0.86.39 -PrevVersion v0.86.38
```

### v0.86.38 통합·출고 확인 범위 (기록 보존)

이번 마일스톤은 추적 목록의 제출/표시 기준과 현재 목록에 연결된 상세 선택이다. 서버 API나
공통 인증/클라이언트·업무 계산은 바꾸지 않으며 Go 제품 변경은 기본 버전 표시뿐이다.

- [x] 한글 조회 기준·표시 응답 조건/시간대·이전 결과·실패와 현재 페이지 최대 200건 범위 안내
- [x] 기존 v1 비활성 및 정상 선택 대조, 일시 잠금의 실제 클릭 차단·버튼/초점 유지
- [x] 실제 Query 객체/성공 횟수·조건/선택 수명과 부모 승인 연결, 정상 새 목록 재확인
- [x] 기존 URL/초안/Legacy/읽기 전용/정확한 참조·시각과 같은 조건의 열린 상세 보존
- [x] v38 기본 버전·OpenAPI·생성물·정규 SBOM/라이선스·내장 UI 정합
- [x] 전체 UI 단위/정적 검사·Go 일반·실제 인증/공급자·구성요소·후보 컨테이너 검사
- [x] 동일 최종 입력의 Go 레이스/vet와 전체 합성 브라우저 실행 완료
- [x] 정확한 메인·태그·최종 이미지·공개 파일 7종의 후속 출고 검증

당시 동결 후보의 전체 UI 단위 2,998개/211파일·Node 45개 통과/선택 실행 3개 건너뜀과 정적 검사,
236,455바이트·37경로 빌드를 확인했다. 신규 9개·기존 관련 27개 합성 브라우저는 커서 fixture 교정 뒤 재시도 없이
통과했고 전체 35파일/808개도 808번 시도로 통과했다(재시도·불안정 통과·건너뜀·전역 오류 0).
Go 일반·레이스는 각각 2,375개 통과 기록/최상위 1,479개·12패키지/선택 실행 12개 건너뜀이며
기존 관리자 필수 회귀 15개·내장 UI/API와 vet도 통과했다. 실제 인증 11개·기존
공급자 업무 1개·보고서 보호 16개, OpenAPI 468경로·타입 불변·루트 포함 SBOM 404개 및 동일 생성
시각 재현, API/SDK·frontend/후보 이미지 취약점·표준 smoke/Trace 직접 연결 검사는 별도로 확인했다.
govuln의 영향 경로 0과 미호출 모듈 취약점 4개를 구분하고 이미지는 미커밋 후보 라벨로 보존한다.
통합 전 부분 검사·최초 RED·기존 이력 복귀 fixture 교정은 [인수 검증표](APP_UI_ACCEPTANCE.md)에
분리하며 최종 로컬 통과로 원격/출고 게이트를 대체하지 않는다.
클라이언트 제출 조건은 서버 정규화 증명이 아니고 현재 페이지 집계는 전체 추적이 아니다.
서버 원자적 권한 취소·완전한 분산 추적·운영 Stable 또는 전체 Phase 완료를 주장하지 않는다.

이후 메인 `e62041e11b876c5436f27b5e05441fb58e35422a`와 태그 객체
`68ba45862f19dcdeb084193a43a38d5753b617b9` 기준으로 v0.86.38을 게시했다
(릴리즈 `401155723`, 2026-10-01 16:33:54 UTC). 표준 게시 절차는 PowerShell 7에서
`-PrevVersion v0.86.37`을 명시했다. 표준 검증 및 별도의 실제 다운로드로 공개 7개 파일을
로컬 산출물과 비교하고 독립 재해시도 통과했다. 원격 메타데이터 확인과 다운로드 바이트 확인은
별도 증거이며, 이를 아카이브 내부 계층 검증·이미지 실행·운영 배포나 v39 통과로 확대하지 않는다.

### v0.86.37 통합·출고 확인 범위 (기록 보존)

이번 마일스톤은 기존 정책 가져오기·내보내기 API를 연결한 파일 검토·원자적 적용·원문 백업이다.
단순 API 선언 또는 검사 추가만을 기능 완료로 세지 않는다. 다음 항목은 중간 근거와 후속 출고를 구분한다.

- [x] 전체 입력·규칙 소유권 검증과 한 DB 트랜잭션 적용, 후행 실패 롤백 및 성공 후 캐시 무효화
- [x] 규칙 생략/null 유지·빈 배열 제거·배치 내 명시 교체 정책 간 이동·충돌 거부
- [x] 단일 조회 내보내기·명시적 빈 규칙 배열·국소 숫자 보존과 기존 typed API/권한 호환성
- [x] cp3 파일/기준 고정·한글 비교·현재 권한·명시 확인·미확정 응답 잠금·확정 적용/조회 실패 구분
- [x] cp3 실제 원문 다운로드·마스킹 검토·늦은 응답/다운로드 및 기존 목록 캐시 경계
- [x] cp4 하단 동작 영역·계획 초점 위치·한글 표시 보완의 단위·브라우저·접근성/시각 확인
- [x] 기본 AppVersion·env/helper·CI 버전과 실제 Go 서버 OpenAPI·생성 타입·정규 SBOM/라이선스 정합
- [x] v37 최종 소스/내장 에셋의 전체 UI·Go 정상/레이스·실제 인증·구성요소·컨테이너 로컬 검증
- [x] 정확한 PR/메인 CI와 문서 배포·안전 인증 요약, 태그·이미지·공개 7개 파일 재다운로드 확인

통합 전 cp3 신규 UI 단위 90개·관련 363개/23파일과 전용 합성 브라우저 18개, 별도 시각/키보드
대조를 확인했다. 실제 Go Routes/SQLStore는 SQLite/PostgreSQL 정상·레이스 각각 최상위 44개와
하위 74개가 통과했으며 신규 가져오기 16개/37개는 양 DB에서 실행됐다. 포함된 일부 기존 회귀는
SQLite 전용이다. OpenAPI 정상·레이스 18개와 실제 서버 명세 생성은 별도 계약 근거다.
이 중간 소스·v36 라벨 증거를 cp4/v37 최종 통과나 같은 실행의 UI→Go 업무 E2E로 합치지 않는다.

후속 cp4/v37 최종 로컬 결과는 신규 단위 93개·관련 366개/23파일, 전체 2,961개/208파일과
Node 45개 통과/선택 실행 3개 건너뜀, TypeScript/lint/format 통과다. 전용 브라우저 19개와
전체 799개/799시도는 재시도·불안정 통과·건너뜀 없이 통과했다. 별도 시각 2개/8장은 직접
검토했으며 snapshot 기준으로 승격하지 않았다. 초기 전송량 236,426/350,000바이트와 37개
경로 예산도 통과했다. 최종 내장 UI의 Go 일반·레이스는 각각 2,375개 통과 기록/최상위 1,479개,
선택 검사 12개 건너뜀이며 vet·기존 관리자 UI 15개를 포함한다.
실제 인증 안전 요약 11개·기존 공급자 연결 업무 1개·별도 보고서 보호 11개/5개를 확인했다.
최초 라이브 Docker 125는 읽기 전용 마운트 아래 없는 무시 경로의 준비 오류로 보존했으며,
허용된 빈 디렉터리 준비 뒤 동일 바이너리로 통과했다. 전체 라이브 최초 통과라고 표시하지 않는다.
실제 기본 버전37의 명세 468경로·생성 타입, 기존 403개 의존성/루트 포함 SBOM 404개와
라이선스 재현, API surface/SDK/구성요소와 fresh 높은/심각 취약점 게이트, nonroot·오프라인·
CSP·정책 직접 연결·표준 컨테이너 smoke를 확인했다. 소스·에셋 전후 해시는 동일하다.
이 미커밋 후보 이미지와 로컬 검사를 최종 태그 이미지·원격 CI·공개 7개 파일 검증으로 대체하지 않는다.

검토 전후 비교는 서버 CAS가 아니며 감사는 count-only best-effort다. 후속 모의 검사/시드 기록과
다른 pod의 기존 캐시 만료도 유지한다. 백업은 민감한 원문을 포함할 수 있고, 재가져오기는 브라우저의
안전한 숫자/필드 범위에 제한된다. 파일에 포함된 정책 ID의 재적용을 전체 DB 복구·누락 정책 삭제·
감사 되돌리기·원본 파일 바이트 복원·정확히 한 번 실행으로 표현하지 않는다. 기본 OFF·Preview를
유지하며 전체 Phase 완료나 Stable 승격은 별도 운영 근거가 필요하다.

후속 PR64와 메인 `0686c14c`의 CI 10개·문서 배포 3개·인증 안전 요약 11개 및 최종 이미지를
확인하고 v0.86.37을 게시했다(릴리즈 `401070963`). 표준 배포 검증과 별도 공개 7개 파일의 실제
다운로드·로컬 크기/체크섬 비교·독립 감사를 마쳤다. 운영 배포를 실행한 것은 아니며 위 중간
실패/교정 기록을 지우거나 이 출고 증거를 v38 최종 게이트로 재사용하지 않는다.

### v0.86.36 통합 당시 확인 범위 (기록 보존)

아래는 당시 후보의 검사·대기 기록이며 v37 최종 게이트의 통과 근거로 재사용하지 않는다.

세션 상세의 명시 재조회·이전 기록 표시·현재 응답의 CSV 내보내기와 한글 결과 안내를
개선한다. 기존 API·CSV 열·마스킹된 응답 ID 호환성을 유지하며 다음 항목을 별도 검증한다.

- [x] 일반·마스킹된 표시 ID의 정상 조회/CSV 및 요청 대상의 독립성
- [x] 계정·팀·권한·세션·대상 왕복과 닫힘 뒤 오래된 GET/CSV 콜백 거부·현재 동작 복구
- [x] 실제 캐시 무효화·같은 시각/동일 객체 새 응답·React 알림 전 내보내기 차단
- [x] 재조회 중·실패의 이전 DOM/초점 유지, 반복 실행 방지, 새 성공 뒤 CSV 복구
- [x] 목록 기간·검색·실패·목록 밖 직접 상세의 독립성과 한글/빈 상태/중립 판정
- [x] 실제 HTTP 마스킹 ID·기간·조회 상한 계약과 합성 브라우저 증거의 분리
- [x] 전체 Go·프런트엔드·인증·내장 UI·SBOM·컨테이너 확인
- [ ] 정확한 원격 PR·병합 커밋 CI 확인
- [ ] 태그·최종 이미지·공개 파일 7종의 실제 다운로드 및 로컬 결과와 체크섬 비교

구현 전 테스트의 정상 대조와 실패는 최종 후보의 통과가 아니다. 서버 응답 자체의 대상·
원자적 권한 취소·완전한 세션 기록·모든 개인정보 제거·운영 Stable 승격을 증명하지 않는다.

최종 후보의 전체 단위 2,868개/203파일·브라우저 780개, Go 일반/레이스 각 2,318개 통과 기록,
실제 인증 11개·공급자 연결 1개·보고서 보호 16개와 빌드·계약·컨테이너 검사를 확인했다.
기존 브라우저의 재열기 기대값을 수정한 뒤 전체 UI 검사를 다시 수행했으며 원래 실패도 보존했다.
이 마지막 테스트 1파일 수정 전후 제품 코드·내장 에셋은 동일하다. Go 미호출 의존성 권고 4건,
라이선스 NOASSERTION 47건과 운영 Stable 승인은 별도로 남겨 둔다.

### v0.86.35 출고 당시 확인 범위 (기록 보존)

이번 변경은 세션 목록의 기간·검색·이전 응답 안내와 새 상세 열기의 현재 목록 확인을
보강한다. 기존 상세 API·CSV·서버 업무·공통 인증은 유지한다.

- [x] 새 기간 보류/실패·같은 기간 재조회 실패·응답 기간 미확인·로컬 검색 빈 결과 구분
- [x] URL `days/q`와 입력 정합성, 상세 여닫기·재조회 중 미제출 초안 보존
- [x] 실제 목록 성공 세대·무효화·필터 왕복·오래된 콜백의 새 상세 열기 차단
- [x] 기존 행/키보드 초점 유지, 이미 열린 상세·직접 연결과 목록 실패의 분리
- [x] sessions 소유자·세 인증 모드·읽기 전용 조회·현재 계정/팀/세션 정상·거부 대조
- [x] 단위·API fixture 브라우저·390px 다크·키보드·접근성과 기존 화면 회귀
- [x] 최종 후보 버전의 전체 Go/프런트엔드·실제 인증·OpenAPI·구성요소·컨테이너 검증
- [x] 정확한 메인 CI·태그·최종 릴리즈 이미지·공개 7개 자산 재다운로드 확인

후보의 관련 구성요소 224개, 전체 단위 2,822개/202파일·브라우저 758개/32파일과 별도
실제 인증 11개·공급자 연결·보고서 보호 16개를 확인했다. 기본 `AppVersion`, helper, 변경
이력과 실제 서버의 OpenAPI 버전을 먼저 갱신한 뒤 같은 소스·내장 UI에서 검사했다. 상세의 서버
요청 상한 표기와 실제 저장소 제한은 다르므로 UI는 ‘목록 기간과 별개인 제한된 최근 요청’으로
설명한다. 미리보기·CSV 전체의 무원문, 전체 검색·완전한 집계·Stable 승격을 보장하지 않는다.

최종 메인 `0861b1ea`의 CI 10개·문서 배포 3개와 인증 안전 요약 11개를 확인한 뒤
2026-10-01에 v0.86.35를 게시했다. 공개 파일 7종을 실제로 내려받아 게시 전 로컬 파일의
크기·SHA256과 모두 일치함을 확인했다. 태그 객체·정확한 메인 리비전의 nonroot 이미지와
정규 SBOM/라이선스/운영 도구도 검증했다. 이 출고 근거를 v0.86.36 검사로 재사용하지 않는다.

### v0.86.34 출고 당시 확인 범위 (기록 보존)

이번 변경은 **요청 탐색기의 상세창에서 명시적으로 처리 단계 조회**만 확장한다. 기존 안전 GET과
엄격한 응답·표·타임라인을 재사용하며 서버·OpenAPI·업무 로직·비교 계약·공통 인증은 유지한다.

- [x] v2 원래 참조/나노초 시각, 클릭 전 GET 0, v1·부적합한 시각에서 임의 보정/원문 우회 0 확인
- [x] 요청/추적 기대 소유자와 실제 기능 승인 일치, 세 인증 모드·읽기 전용·현재 범위/팀/세션 확인
- [x] 목록 질의·성공 응답 세대로 선택 폐기. 동일 시각/응답·필터/권한/팀 왕복에서 옛 선택 부활 0
- [x] 부모 갱신 중 DOM/초점 유지와 새 조회 잠금, 실패/LKG 비승인, 성공 뒤 닫힘과 현재 행/제목 초점
- [x] 기존 요청·추적·비교 회귀, 명시 재조회·늦은 응답·390px 다크·키보드·axe 확인
- [x] 새 성공 DTO의 무원문 범위와 기존 비교/오류 캐시를 구분. API fixture 브라우저와 실제 Go 검사를 구분
- [x] 동일 UI 소스·내장 에셋의 전체 단위/브라우저 및 교정한 기본 버전의 실제 격리 인증 확인
- [x] 교정 후 최종 메타데이터의 전체 Go normal/race·버전 회귀·구성요소 재검증 확인
- [x] 최종 스냅샷 포함 컨테이너 입력 일치와 재검증 완료 확인
- [x] 정확한 main CI·태그·최종 릴리즈 이미지·공개 7개 자산 재다운로드 확인

현재 단위 2,786개/200파일·독립 관련 180개·전용 브라우저 18개와 실제 격리 인증 11개·로컬
공급자·보고서 보호를 통과했다. 전체 브라우저 739개/31파일(재시도 0), Go normal/race·기존
관리자·사전 컨테이너도 검사했다. 첫 PR CI는 기본 `AppVersion`이 v0.86.33에 남아 있는 것을
기존 버전 일치 테스트가 탐지해 실패했다. 배포 helper·변경 이력 갱신 전 Go 통과는 최종 버전
검증이 아니며, `-X`로 버전을 주입한 이미지 통과도 기본 버전 일치를 증명하지 않는다.
기본 버전을 v0.86.34로 교정하고 최종 메타데이터 기준 전체 Go·인증·이미지를 다시 확인한다.
두 번째 PR CI에서는 실제 서버와 비교하는 OpenAPI 검사가 스냅샷의 이전 버전 표기를 탐지했다.
별도 버전 주입 없이 빌드한 격리 서버에서 문서를 받아 표준 생성기로 동기화했다. 이 변경은
`info.version` 한 항목이며 경로·스키마·생성 TypeScript는 변경하지 않는다.
교정한 Go 전체 normal/race 각 2,309기록·1,457개 상위 검사, vet/build·버전 회귀가 통과했다.
스냅샷 교정 후 생산 빌드 산출물 139개도 기존 검증 UI와 바이트 단위로 동일했다.
이전 v0.86.33 출고나 부분 통과를 원격 검증으로 재사용하지 않는다.
최종 `a6ec045b`의 메인 CI 10개·문서 배포 3개·인증 안전 요약 11개를 확인한 뒤
2026-10-01에 v0.86.34를 게시했다. 정확한 소스의 최종 이미지·annotated tag와 공개 7개
파일을 재다운로드 검증했다. 이 출고 기록은 다음 후보 v0.86.35의 검증이 아니다.

릴리즈 메타데이터를 모두 갱신한 **뒤**, 커밋 전에 다음 기존 검사를 먼저 실행하고 전체 회귀를
수행한다. `internal/proxy/server.go`의 `AppVersion`, 변경 이력, `.env.example`, 배포 helper,
UI 빌드 버전, CI의 SBOM 버전과 정규 SBOM을 같은 대상 버전으로 맞춘다.
`web/openapi/openapi.json`의 버전도 실제 서버 출력과 맞춰야 한다. 파일 자체의 생성 일치 검사
뿐 아니라 실제 `/openapi.json`을 입력한 `pnpm openapi:check -- <파일>`까지 통과해야 한다.

```bash
go test ./internal/proxy -run '^(TestDeploymentEnvHelperReleaseVersion|TestAppVersionNotBelowReleaseNotes)$' -count=1
```

### v0.86.33 출고 당시 확인 범위 (기록 보존)

이번 변경은 추적 탐색기의 **선택 요청 메타데이터·직접 하위 단계 조회**만 대상으로 한다.
기존 `/admin`·인증·업무 API·인덱스와 Preview 상태를 유지한다.

- [x] 기존 v2 요청 참조·원래 UTC 나노초 시각, 엄격한 GET 매개변수와 모든 응답의 `no-store` 확인
- [x] 실제 SQLite/PostgreSQL에서 후보 200개·소스별 100개 경계, 팀/키 이동·삭제·오류·취소 확인.
  원문 열 없는 최소 스키마 검사와 자연 대규모 실행 계획을 별도 기록하고 강제 인덱스 검사를
  자연 계획으로 보고하지 않음. 하위 표시 필터·시간 정렬은 후보 상한 뒤 적용
- [x] 실제 HTTP 인증·권한·팀 범위와 제어된 읽기 시점의 회전/세션 검사를 구분. 균일 404의
  대상을 명시하고 DB/checked 팀 식별 오류의 500을 빈 결과로 숨기지 않음
- [x] 생성 OpenAPI 타입과 엄격한 응답 검증, 루트 시각/위치·부모/중복/대상/상한 위반 거부 확인.
  구버전 오류에서 원문 추적 API로 우회하지 않으며 프롬프트·SQL·도구 인자를 새 DTO에 넣지 않음
- [x] 목록과 상세의 읽기 권한·계정 왕복·세션/선택 수명, 이전 데이터·늦은 응답·수동 재조회 확인.
  조회 원문을 URL/영속 저장소에 추가하지 않음. 기록 시각·음수 상대 위치·미기록 지연을 구분
- [x] 딥 링크·390px 다크·실제 키보드 가로 읽기·부모 갱신 중 초점 유지·axe 검증.
  합성 API 브라우저를 실제 UI→Go 동일 실행이나 운영 Preview 검증으로 합산하지 않음
- [x] 최종 v0.86.33 소스·생성 계약·버전·SBOM·내장 애셋 일치와 전체 회귀·실제 인증·컨테이너·
  원격 CI·태그·7개 배포 파일 확인. 후보 검증만으로 출시·Stable·Phase 완료를 선언하지 않음

로컬 최종 소스는 Vitest 2,745개/199파일·브라우저 721개(재시도 0), 전체 Go normal/race,
실제 인증 11개·로컬 공급자·비밀 없는 실패 보고서 검사를 통과했다. 최초 실패와 수정 근거는
분리해 보존했다. 최신 구성요소 검사와 SBOM 일치가 최종 이미지·원격 CI 검사를 대신하지 않으며,
Go 비도달 모듈 취약점 4건과 라이선스 `NOASSERTION` 47개도 그대로 추적한다.

최종 메인 `4668c416`의 CI 10개·문서 배포 3개와 인증 안전 요약 11개를 확인한 뒤
2026-10-01에 v0.86.33을 게시했다. 태그 소스와 공개된 7개 파일의 체크섬·SBOM·라이선스·
운영 도구를 재다운로드 검증했다. 이 근거는 v0.86.34의 새 구현·CI 검증이 아니다.

### v0.86.32 통합 당시 확인 범위 (기록 보존)

아래 항목은 당시 후보 검토의 기록이다. 이후 최종 `e1357ca1`의 CI와 7개 배포 자산을 확인해
2026-10-01에 v0.86.32를 게시했다. 이 릴리즈는 v0.86.33의 검사를 대신하지 않는다.

이번 변경은 **기존 비활성 정책 한 건의 메타데이터·복수 규칙 편집**만 대상으로 한다.
이름·설명·우선순위와 규칙 수정·추가·삭제·전체 비우기를 한글로 비교하고, 기존 적용 비율과
비활성 상태를 유지한다. 기존 정책 생성·사용/중지·캐너리·시뮬레이션이나 서버 업무를 바꾸지 않는다.

- [ ] 고정한 정책 ID·원본 전체와 검토 본문을 확인. 미편집 규칙 ID와 중첩 JSON을 보존하고,
  전체 규칙 비우기는 명시 확인. 실제 GET/ACK의 `rules` 생략과 `null`/비정상 원본을 구분
- [ ] 저장 시 바뀌는 정책 ID는 진입 차단. 유지할 수 없는 규칙 ID·비정규 최상위 JSON 키는
  규칙/해당 JSON 전체 교체 또는 삭제 없이 암묵 변환하지 않음. 음수 우선순위의 유효 계약 유지
- [ ] 보호된 기존 원문은 DOM에 노출하지 않고 유지/명시 교체·삭제하며 새 민감 입력은 거부.
  마스킹 문구 전송·초안 URL/영속 저장·새 초안의 Query/Mutation Cache 보관 없이 처리하되,
  기존 원문 GET·캐시·저장·감사 제거나 모든 개인정보 보호로 확대하지 않음
- [ ] 현재 기능 소유자·읽기 전용·`security:read`/`admin:write`·세션·사용자·수명과 목록 상태를
  실제 저장 직전에 재확인. 직전 GET의 원본 대조를 서버 CAS나 동시 편집 차단으로 설명하지 않음
- [ ] 정책 ID·비활성·검토 값·정상 규칙 ID의 ACK 확인 후 저장 성공과 후속 GET 실패를 분리.
  불명확한 ACK는 미저장으로 단정하거나 자동 반복하지 않으며, 기존 공유 Client의 401 인증
  갱신 후 재전송은 유지. 명시적 재조회에서 같은 원본 전체를 확인하기 전 재저장 잠금,
  변경·삭제·조회 실패의 잠금 유지와 서버 멱등성 미보장을 확인
- [ ] 한 정책/규칙의 트랜잭션 전체 교체와 별도 감사·조건부 `dry-run`/초기 설정 부작용을 구분.
  전체 DB 무변경·원자적 감사·저장 취소·운영 비용 없음을 보장하지 않음
- [ ] 통합 전 신규 82개·전체 Vitest 2,677개/195파일 및 전용 합성 브라우저 22개/전체 695개를
  이전 v0.86.31 표시의 후보 근거로 보존. 첫 모바일 fixture 인자 누락과 교정 결과도 별도 기록
- [ ] 실제 Go Routes·임시 SQLite의 `policy_editor_http_test.go` 최상위 7개/하위 16개 normal/race와
  raw wire의 빈 규칙 생략 검사를 별도 기록. 최초 세션 ID 중복은 하네스 오류이며 제품 수정이 아님.
  실제 편집 UI→Go 동일 실행·PostgreSQL·전체 후속 감사/모의 검사 검증으로 합치지 않음
- [x] 최종 v0.86.32 `e1357ca1`: 원격 CI 10개 작업, 전체 Vitest 2,688개/195파일·브라우저
  698개(재시도/불안정 0), 실제 인증 11개 안전 요약, 컨테이너·태그·7개 배포 파일 확인.
  통합 전 근거와 분리하며 출고를 운영 Stable 승격·전체 Phase 완료로 확대하지 않음

### v0.86.31 통합 당시 확인 범위 (기록 보존)

다음은 v0.86.31 준비 당시의 범위와 사전 근거를 보존한 기록이다. v0.86.32의 새 검사 결과가 아니다.

이번 정책 어드바이저 변경은 **추천에서 비활성 정책 초안을 생성하는 검토 경로만** 대상으로 한다.
기존 정책 CRUD·캐너리 변경·순수 시뮬레이션 API나 서버 저장 업무를 새로 구현하지 않는다.

- [ ] 고정한 원래 제목·조건·동작과 저장명 안내, 조회 기준 변경 후 수동 재검토, 현재 화면·
  읽기 전용·기존 권한·세션 확인을 최종 소스에서 검증. UI의 제한을 서버 CAS나 새 RBAC로 설명하지 않음
- [ ] 생성 확인 응답과 후속 목록 조회를 분리하고, 오류·불명확한 응답은 미생성으로 단정하지 않음.
  이 UI는 일반 오류의 자동 재시도를 추가하지 않지만 기존 공유 Client의 401 인증 갱신 후
  재전송은 유지. 수동 재시도도 새 초안을 추가할 수 있어 중복 방지·멱등성을 보장하지 않음
- [ ] 원문 규칙의 새 표시 보호와 기존 원문 감사 저장을 구분. 정책·규칙 저장 후 감사는 별도이며,
  설정에 따라 후속 `dry-run` 모의 검사와 최초 `redteam.seed_version` 설정·이력이 생길 수 있음.
  DB 전체 무변경·원자적 감사·실제 저장 취소·운영 비용 없음으로 설명하지 않음
- [ ] 통합 전 신규 단위 57개/관련 180개·전체 Vitest 2,595개와 합성 브라우저 13개/전체 673개는
  이전 v0.86.30 표시의 후보 근거로 보존. 검토 보강을 위한 앞선 의도 중단과 최초 실패도 보존
- [ ] 실제 Go Routes·임시 SQLite의 `policy_advisor_apply_http_test.go` 최상위 5개/하위 16개
  normal/race 근거를 별도 기록. 최초 설정 불변 기대의 오류 교정은 제품 수정으로 세지 않으며,
  이 검사를 실제 초안 UI→Go 브라우저·PostgreSQL·운영 데이터 검증으로 확대하지 않음
- [ ] 최종 v0.86.31의 소스·생성 API·버전·SBOM·내장 애셋 일치, 전체 회귀·실제 인증·컨테이너·
  원격 CI·태그·7개 배포 파일을 별도 확인. 현재 사전 통과만으로 출고·Stable·전체 Phase 완료를 승인하지 않음

세부 범위와 한계는 [신규 콘솔 인수 검증표](APP_UI_ACCEPTANCE.md)를 따른다.

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
VITE_UI_VERSION=v0.86.40 pnpm --dir web build
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
go run -ldflags "-X vibe-coders/internal/proxy.AppVersion=v0.86.40" ./cmd/gateway
```

### Linux / macOS

```bash
UPSTREAM_API_KEY=sk-... \
GATEWAY_SECRET=dev-only-secret \
ADMIN_TOKEN=dev-admin \
UI_APP_ENABLED=true \
go run -ldflags "-X vibe-coders/internal/proxy.AppVersion=v0.86.40" ./cmd/gateway
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
$VERSION = "v0.86.40"
git tag -a $VERSION -m "Release $VERSION"
git push origin $VERSION
```

---

## 5. 오프라인 배포 패키지 빌드 (Docker 이미지)

릴리즈 스크립트 한 번으로 3-stage Docker 이미지 빌드 → container smoke → Grype 이미지 검사 → tar.gz 압축
→ SHA256 체크섬 → 오프라인 가이드 생성을 수행합니다. v0.80.0부터는 versioned 통합
SBOM과 제3자 라이선스 목록도 함께 산출합니다. PowerShell 경로도 동일한 smoke를 위해
Bash, curl, Python 3와 Grype 0.117.0이 필요합니다. Grype 검사는 실제 최종 이미지에서
High·Critical 취약점을 발견하면 패키징 전에 실패합니다.
대상 플랫폼이 빌드 호스트와 다르면 최종 이미지를 실행할 수 있도록 Docker binfmt/QEMU를
먼저 구성하거나 대상 아키텍처 호스트에서 빌드해야 합니다. Smoke를 실행할 수 없는
cross-platform 이미지는 릴리스 스크립트가 패키징하지 않습니다.

### Windows / PowerShell

```powershell
pwsh -File scripts/release.ps1 -Version v0.86.40
```

### Linux / macOS

```bash
./scripts/release.sh -v v0.86.40 -p linux/amd64
```

### 스크립트 처리 단계

| 단계 | 설명 |
|------|------|
| **[1/5] docker build** | Node 24+pnpm frozen → Go 1.26.8 embed → distroless nonroot 3-stage 이미지 생성 |
| **[verify] container smoke** | `/admin`, `/app` 308/deep link, hashed asset cache, `/auth/me` build version, root 소유 볼륨의 진단·`repair-data-dir` 복구·재기동 검증 |
| **[verify] image CVE** | Grype 0.117.0으로 최종 이미지의 High·Critical 취약점 차단 |
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
  ai-coding-proxy-gateway-v0.86.40.tar.gz        ← Docker 이미지 패키지
  ai-coding-proxy-gateway-v0.86.40.tar.gz.sha256 ← SHA256 체크섬
  README-offline-v0.86.40.md                      ← 오프라인 배포 가이드
  SBOM-v0.86.40.spdx.json                         ← Go+npm 통합 SPDX SBOM
  THIRD_PARTY_LICENSES-v0.86.40.md                ← Go·Frontend 라이선스 목록
  init-deployment-env-v0.86.40.sh                 ← 운영 env 원자 생성·검증
  backup-volume-v0.86.40.sh                       ← named volume·env 백업·복구
```

### 파라미터 옵션

```powershell
# 버전 지정
pwsh -File scripts/release.ps1 -Version v0.86.40

# 이미지 이름 변경
pwsh -File scripts/release.ps1 -Version v0.86.40 -Image my-gateway

# ARM64 빌드 (애플 실리콘 / ARM 서버)
pwsh -File scripts/release.ps1 -Version v0.86.40 -Platform linux/arm64
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
pwsh -File scripts/gh_release.ps1 -Version v0.86.40 -PrevVersion v0.86.39
```

raw `gh release create`로 직접 게시하지 않습니다. 위 스크립트는 clean tree, annotated tag,
`origin/master`와 성공한 CI, 7개 payload의 manifest/hash, tagged canonical
SBOM·라이선스·운영 helper를 게시 전에 검증합니다. 직접 명령은 이 fail-closed gate를
우회하므로 지원하지 않습니다.

### 6.3 릴리즈 확인

```powershell
gh release view v0.86.40 --repo hkjang/vibe-coders
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
ai-coding-proxy-gateway-v0.86.40.tar.gz
ai-coding-proxy-gateway-v0.86.40.tar.gz.sha256
README-offline-v0.86.40.md
SBOM-v0.86.40.spdx.json
THIRD_PARTY_LICENSES-v0.86.40.md
init-deployment-env-v0.86.40.sh
backup-volume-v0.86.40.sh
```

### 7.2 무결성 확인

```bash
sha256sum -c ai-coding-proxy-gateway-v0.86.40.tar.gz.sha256
# 정상: ai-coding-proxy-gateway-v0.86.40.tar.gz: OK
```

### 7.3 이미지 적재

```bash
gunzip -c ai-coding-proxy-gateway-v0.86.40.tar.gz | docker load
# 정상: Loaded image: ai-coding-proxy-gateway:v0.86.40
```

### 7.4 단일 컨테이너 실행

```bash
chmod 0700 init-deployment-env-v0.86.40.sh backup-volume-v0.86.40.sh
sudo env GATEWAY_VERSION=v0.86.40 \
  ./init-deployment-env-v0.86.40.sh /opt/proxy-gateway/gateway.env
docker volume create proxy-gateway-data >/dev/null
# 기존 볼륨·바인드 마운트를 재사용할 때 소유권을 nonroot(65532)로 복구합니다. 새 볼륨은 변경 없이 끝납니다.
docker run --rm --user 0:0 --mount source=proxy-gateway-data,target=/data \
  ai-coding-proxy-gateway:v0.86.40 repair-data-dir
docker run -d --name proxy-gateway --restart=always \
  -p 8080:8080 \
  --mount source=proxy-gateway-data,target=/data \
  --env-file /opt/proxy-gateway/gateway.env \
  ai-coding-proxy-gateway:v0.86.40
```

초기화 helper가 upstream key를 숨김 입력받습니다. `ADMIN_TOKEN`과 `GATEWAY_SECRET`은
최초 1회만 생성하고 env 파일과 데이터 볼륨을 함께 백업해야 합니다. 두 versioned helper는
체크섬 manifest와 tagged source 비교 대상이므로 별도 소스 checkout 없이 폐쇄망에서 사용합니다.

### 7.5 docker compose 실행

```bash
sudo env GATEWAY_VERSION=v0.86.40 \
  ./init-deployment-env-v0.86.40.sh /opt/proxy-gateway/gateway.env
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

8080이 연결되지 않고 컨테이너가 재시작을 반복하면 `docker logs --tail 20 proxy-gateway`를 확인합니다.
`data directory /data is not writable`이면 `docs/OPERATIONS.md` 8.6절의 `check-data-dir` → `repair-data-dir` 절차로
볼륨 소유권을 nonroot(65532)에 맞춘 뒤 재기동합니다.

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
bash scripts/container-smoke.sh ai-coding-proxy-gateway:v0.86.40 v0.86.40
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
  --image ai-coding-proxy-gateway:v0.86.40 \
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

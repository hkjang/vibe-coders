# 심사·재현 테스트

루트에서 다음 명령을 실행합니다.

```bash
go version                 # go.mod가 요구하는 Go 1.26 이상 확인
go mod download
go mod verify
go test ./...
bash tests/smoke.sh
```

`go test ./...`는 저장소의 단위·통합 테스트 전체를 수행합니다.
`tests/smoke.sh`는 외부 API key나 네트워크 호출 없이 임시 mock upstream과
gateway를 시작해 `/health`, `/ready`, `/v1/models`, 비스트리밍
`/v1/chat/completions` 중계를 검증합니다. 테스트 프로세스와 임시 데이터는
종료 시 정리됩니다.

Docker 재현은 루트 README의 "독립 실행 및 심사 재현" 절을 따릅니다.

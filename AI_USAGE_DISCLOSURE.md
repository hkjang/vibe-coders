# AI usage disclosure

이 저장소는 개발 과정에서 생성형 AI 개발 보조 도구를 사용했습니다. 아래 내용은
Git 이력과 개발 PC에 남아 있는 Codex 세션 메타데이터를 2026-07-22에 대조한
결과입니다. 세션 원문에 포함될 수 있는 비밀키, 토큰, 내부 주소, 사용자 입력과
응답 전문은 이 문서에 옮기지 않았습니다.

## 확인된 사용

- Git 커밋 이력의 `Co-Authored-By` 및 세션 표시에 따라 Anthropic Claude
  Opus 4.8과 Claude Fable 5가 기능 구현, UI 개선, 테스트 및 문서 작업을
  보조했습니다.
- 2026-07-22에 OpenAI Codex가 소스·의존성·Git 이력을 분석하고 `NOTICE`,
  `THIRD_PARTY_LICENSES.md`, `MODEL_CARD.md`, 이 문서, SPDX SBOM, 재현 테스트와
  README 보완 초안을 작성했습니다.

## 확인된 Codex 세션

세션은 로컬 JSONL의 `session_meta.cwd`가 프로젝트 경로와 일치하는지를 기준으로
선별했습니다. 시간 범위는 세션 이벤트의 UTC 타임스탬프이며 한국 표준시(KST)는
UTC+9입니다. 모델명과 Codex 버전은 당시 세션 메타데이터에 기록된 값입니다.

### Windows 환경

| 세션 | 기간(UTC) | 실행 환경 | Codex/모델 | 확인된 작업 범위 |
| --- | --- | --- | --- | --- |
| `019e858c-83ff-7400-b5d2-99a7d2db394c` | 2026-06-01 ~ 2026-07-01 | Codex Desktop, `C:\Users\<USER>\projects\vibe-coders` | Codex Desktop 0.135.0-alpha.1, GPT-5.4·GPT-5.5 | 사용자별 통계와 LLM observability, intelligent routing, 인증·팀·역할·scope, governance, 안정화·문서, MCP gateway/agentic discovery, Chat 테스트, 멀티모델 비교, XView, red-team 운영 기능, UI/UX, 테스트·커밋·릴리스 보조 |
| `019e816c-6572-7832-80a5-cbe109533feb` | 2026-06-01 ~ 2026-06-07 | Codex Desktop, `C:\Users\<USER>\projects\vibe-code-1.0.0` | Codex Desktop 0.135.0-alpha.1, GPT-5.4·GPT-5.5 | VS Code 확장 전신 작업과 문서화, `vibe-coders` gateway 호출 연계 체계 구축 보조. 작업 디렉터리가 현재 저장소와 다르므로 현재 프로젝트의 직접 구현 세션과 구분함 |

첫 번째 Windows 세션은 약 한 달간 이어진 장기 세션으로, 메타데이터에서 145개의
사용자 turn과 다수의 소스 조회·수정·테스트 명령이 확인됩니다. 이는 AI가 넓은
범위의 구현을 보조했다는 근거이지, 모든 제안이 검토 없이 병합되었다는 뜻은
아닙니다.

### WSL 환경

WSL 세션의 작업 경로는 모두
`/mnt/c/Users/<USER>/projects/vibe-coders`였고 Codex TUI를 사용했습니다.

| 세션 | 기간(UTC) | Codex/모델 | 확인된 작업 범위 |
| --- | --- | --- | --- |
| `019f6325-7043-7ad1-af47-ab2b7b01d2e2` | 2026-07-15 00:23 ~ 05:49 | Codex TUI 0.144.4, GPT-5.6-sol | 팀·보안·비용·DW·MCP·운영·거버넌스·Text2SQL·개인화 화면의 시각화/UI·UX 개선, Waterfall/LLM 관측 SQL 오류와 성능 문제, agent route 및 MCP 조회 문제 분석·수정 보조 |
| `019f680d-f56e-7782-81bc-75caac830d11` | 2026-07-15 23:13 ~ 23:21 | Codex TUI 0.144.4, GPT-5.6-sol | 인증·관리자·gateway secret 변경 후 API key 인식 문제 진단 보조 |
| `019f681d-5ad9-74b1-959f-be96cfc8ef5c` | 2026-07-15 23:35 ~ 23:36 | Codex TUI 0.144.4, GPT-5.6-sol | 유실된 gateway secret로 인한 기존 provider key 복구 방안 검토 |
| `019f6829-01ea-78c3-9bb6-d4dec1afb8b3` | 2026-07-15 23:42 ~ 23:43 | Codex TUI 0.144.4, GPT-5.6-sol | 암호화 secret 불일치에 따른 upstream 호출 실패 진단 보조 |
| `019f6834-226d-7b13-b68a-9f0c23c72855` | 2026-07-15 23:55 ~ 2026-07-16 00:14 | Codex TUI 0.144.4, GPT-5.6-sol | upstream model pattern 환경변수·provider routing·OpenAI-compatible 모델 탐색과 `.env` 적용 문제 분석·수정 보조 |
| `019f882b-b1f3-7473-b81c-0320ce1e6c74` | 2026-07-22 04:53 이후 | Codex TUI 0.145.0, GPT-5.6-sol | 라이선스·모델 카드·AI 사용 공개·SPDX SBOM·독립 실행 README·심사용 smoke test 작성과 검증 |

WSL 기록 중 짧은 장애 대응 세션들은 동일한 비밀정보/암호화 설정 문제를 연속으로
다룬 경우가 있어 별도 세션으로 남아 있지만 작업 범위는 서로 겹칠 수 있습니다.
세션 원본은 개발 PC의 Codex 데이터 디렉터리에만 있으며 프로젝트 배포물에는
포함하지 않습니다.

## 기록에서 확인되지 않은 범위

Codex 세션 메타데이터로 GPT 계열의 사용 사실과 당시 모델 식별자는 확인할 수
있습니다. 반면 별도 ChatGPT 웹 대화, 다른 PC, 삭제된 세션, 로컬 자동완성 또는
메타데이터를 남기지 않은 도구 사용은 소급 확인할 수 없습니다. 따라서 그러한
도구를 사용하지 않았다고 단정하지 않고 확인 가능한 기록만 공개합니다.

## 사용 범위

AI 도구는 코드/문서 초안, 리팩터링 제안, 테스트 생성, 오류 분석 및 UI 문구
개선뿐 아니라 기능 설계, API·DB·라우팅·거버넌스 구현, 운영 장애 진단, 테스트,
릴리스 준비에 사용되었습니다. Codex가 shell·브라우저·소스 편집 도구를 사용해
작업한 세션도 포함됩니다. 제품 실행 중 운영자가 설정한 외부 LLM 호출은 개발
보조 사용과 구분되며, 자세한 런타임 경계는 `MODEL_CARD.md`를 참조하십시오.

## 사람의 책임과 검증

- 변경사항은 사람이 Git diff, 테스트 결과와 라이선스 원문을 검토한 뒤
  채택해야 합니다.
- AI가 제안한 코드는 저작권, 보안, 정확성 또는 제3자 라이선스 준수를 자동으로
  보장하지 않습니다.
- 비밀키와 실제 사용자 데이터는 AI 개발 도구의 프롬프트에 입력하지 않는 것을
  원칙으로 합니다.
- 최종 배포, 모델/provider 선택, 데이터 처리, 법적 준수에 대한 책임은 프로젝트
  유지관리자와 배포 운영자에게 있습니다.

## 한계

이 공개는 저장소에서 확인 가능한 커밋 메타데이터와 현재 작업 기록을 기준으로
합니다. 외부 채팅, 로컬 자동완성 또는 기록되지 않은 세션까지 소급 입증하는
완전한 감사 로그는 아닙니다. 세션의 사용자 turn 수나 도구 호출 수는 작업량의
참고 신호일 뿐 코드 기여량 또는 저작권 지분을 의미하지 않습니다.

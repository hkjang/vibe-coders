---
description: 현재 브랜치의 변경사항으로 한국어 PR 제목과 본문을 작성합니다.
---

다음 절차를 따르세요.

1. 현재 브랜치 확인: `git branch --show-current`
2. 기준 브랜치(기본 `main` 또는 `master`) 대비 변경 확인:
   - `git log <base>..HEAD --oneline`
   - `git diff <base>...HEAD --stat`
   - 필요하면 `git diff <base>...HEAD` 로 실제 변경 살펴봄
3. 변경 내용 분류 — 새 기능, 버그 수정, 리팩터, 성능, 문서 등

**PR 제목 (70자 이내)**:
```
<type>: <한국어 핵심 변화 요약>
```

**PR 본문** — 다음 섹션 구조:

```markdown
## 요약
<1-3 줄로 무엇을 / 왜>

## 변경 사항
- <변경 1>
- <변경 2>
- ...

## 테스트 계획
- [ ] <검증 단계 1>
- [ ] <검증 단계 2>
- [ ] 단위 테스트 통과 확인
- [ ] (관련된 경우) 수동 시나리오 확인

## 위험 / 영향 범위
<배포 후 모니터링이 필요한 지표나 깨질 수 있는 부분>

## 관련 이슈
Closes #<번호>
```

4. **사용자에게 미리 보여주고 확인 받은 후**, 사용자가 원하면 PR 생성 단계로 진행:
   - **외부망 가능**: `gh pr create --title "..." --body "$(cat <<'EOF' ... EOF)"`
   - **사내 GitHub Enterprise**: `GH_HOST=github.company.local gh pr create ...`
   - **GitLab / Gitea / 사내 Bitbucket**: `glab mr create` / 사내 CLI / 또는 명령만 출력 후 사용자가 웹 UI 에서 붙여넣기
5. `gh`/`glab` 등 CLI가 없거나 인증 안 되어 있거나 폐쇄망이면 명령을 실행하지 말고 PR 본문만 출력 후 클립보드 복사를 안내.

규칙:
- 비밀 정보 노출 금지
- 변경된 모든 커밋을 봐야 함 (마지막 커밋만 보지 말 것)
- 한국어 격식체로 작성

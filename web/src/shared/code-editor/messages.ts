import type { CodeLanguage } from "./types";

export const editorMessages = {
  languages: { json: "JSON", sql: "SQL", prompt: "프롬프트" } satisfies Record<CodeLanguage, string>,
  open: "코드 편집기 열기",
  basic: "기본 입력으로 전환",
  loading: "편집기를 준비하는 중입니다. 입력은 계속할 수 있습니다.",
  failed: "코드 편집기를 사용할 수 없어 기본 입력을 표시합니다. 입력 내용은 유지됩니다.",
  large: "대용량 입력은 기본 입력으로 편집할 수 있습니다.",
  help: "Tab으로 다음 항목으로 이동합니다. Esc는 편집기 안의 도구를 닫습니다.",
  find: "내용 찾기",
  undo: "입력 되돌리기",
  redo: "입력 다시 적용",
  format: "JSON 들여쓰기 정리",
  formatFailed: "JSON 형식과 현재 편집 상태를 확인한 뒤 다시 시도하세요.",
  wrap: "자동 줄 바꿈",
} as const;

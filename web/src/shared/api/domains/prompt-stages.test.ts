import { describe, expect, it } from "vitest";
import { stagePage, stageRow } from "../../../../tests/fixtures/prompt-stage-data";
import { stagePageSchema } from "./prompt-stages";

describe("단계 이름·버전의 서버 문자 수 계약", () => {
  for (const field of ["name", "version"] as const) {
    it.each([
      ["한글 경계", "가".repeat(256), true],
      ["한글 초과", "가".repeat(257), false],
      ["이모지 이름", "😀".repeat(200), true],
      ["보충 문자 경계", "𠮷".repeat(256), true],
      ["보충 문자 초과", "𠮷".repeat(257), false],
      ["결합 문자 경계", "e\u0301".repeat(128), true],
      ["결합 문자 초과", "e\u0301".repeat(129), false],
    ] as const)(`${field}: %s`, (_label, value, accepted) => {
      const result = stagePageSchema.safeParse(stagePage([{ ...stageRow, [field]: value }]));
      expect(result.success).toBe(accepted);
    });
  }
});

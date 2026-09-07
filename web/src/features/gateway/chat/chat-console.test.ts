import { describe, expect, it } from "vitest";

import {
  chatTargetOptions,
  maxCompareModels,
  parseCompareModels,
  safeModelLabel,
} from "@/features/gateway/chat/chat-console";

describe("parseCompareModels", () => {
  it("reads model:provider lines, ignores blanks and collapses duplicates", () => {
    const { models, overflow } = parseCompareModels(
      ["gpt-4.1:openai", "", "# comment", "claude-4", "gpt-4.1:openai"].join("\n"),
    );
    expect(models).toEqual([{ model: "gpt-4.1", provider: "openai" }, { model: "claude-4" }]);
    expect(overflow).toBe(0);
  });

  it("caps the run at the server limit and reports the remainder", () => {
    const lines = Array.from({ length: maxCompareModels + 2 }, (_, index) => `model-${index}`).join("\n");
    const { models, overflow } = parseCompareModels(lines);
    expect(models).toHaveLength(maxCompareModels);
    expect(overflow).toBe(2);
  });
});

describe("chatTargetOptions", () => {
  it("replaces an unsafe provider name with a neutral label", () => {
    const options = chatTargetOptions(
      {
        provider: [
          {
            id: "provider:secret",
            kind: "provider",
            label: "sk-live-abcdefghijklmnop · 직접 입력",
            provider: "sk-live-abcdefghijklmnop",
          },
        ],
      },
      [],
    );
    expect(options[0]?.label).toBe("공급자 이름 비공개");
    expect(options[0]?.group).toBe("공급자");
  });

  it("falls back to the flat list when the server sends no groups", () => {
    const options = chatTargetOptions(undefined, [
      { id: "routing:vibe/auto", kind: "routing", label: "vibe/auto", enabled: false },
    ]);
    expect(options[0]?.label).toBe("vibe/auto · 비활성");
  });
});

describe("safeModelLabel", () => {
  it("bounds an operator supplied model id", () => {
    expect(safeModelLabel("")).toBe("모델 미지정");
    expect(safeModelLabel("x".repeat(200))).toHaveLength(121);
  });
});

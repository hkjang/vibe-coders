import { describe, expect, it } from "vitest";

import type { RequestIOMessage, RequestIOPreview } from "@/shared/api/domains/observability.schemas";

import {
  inputSummary,
  outputSummary,
  prettyJson,
  requestIOFinishLabel,
  requestIORoleLabel,
  splitCodeFences,
  splitConversation,
} from "./request-io-model";

const message = (role: string, text = role): RequestIOMessage => ({
  role,
  text,
  chars: text.length,
  truncated: false,
  original_kept: false,
});

const preview = (output: Partial<RequestIOPreview["output"]>): RequestIOPreview => ({
  request_id: "req-1",
  input: { state: "captured", role: "user", text: "질문", truncated: false, chars: 2, message_count: 1 },
  output: {
    state: "captured",
    kind: "text",
    text: "답변",
    truncated: false,
    chars: 2,
    tool_names: [],
    finish_reason: "stop",
    ...output,
  },
});

describe("splitConversation", () => {
  it("separates instructions, earlier turns and the turn this request asked", () => {
    const { earlier, instructions, latest } = splitConversation([
      message("system"),
      message("user", "첫 질문"),
      message("assistant", "첫 답변"),
      message("developer"),
      message("user", "마지막 질문"),
      message("tool", "도구 결과"),
    ]);
    expect(instructions.map((item) => item.role)).toEqual(["system", "developer"]);
    expect(earlier.map((item) => item.text)).toEqual(["첫 질문", "첫 답변"]);
    expect(latest.map((item) => item.text)).toEqual(["마지막 질문", "도구 결과"]);
  });

  it("shows every turn when no message is from the user", () => {
    const { earlier, latest } = splitConversation([message("system"), message("assistant", "답변")]);
    expect(earlier).toEqual([]);
    expect(latest.map((item) => item.text)).toEqual(["답변"]);
  });
});

describe("splitCodeFences", () => {
  it("keeps code monospaced and drops the gaps around it", () => {
    expect(splitCodeFences("앞\n\n```sql\nSELECT 1;\n```\n\n뒤")).toEqual([
      { kind: "text", value: "앞" },
      { kind: "code", value: "SELECT 1;", language: "sql" },
      { kind: "text", value: "뒤" },
    ]);
  });

  it("keeps text without a fence untouched, including its newlines", () => {
    expect(splitCodeFences("\n첫 줄\n둘째 줄\n")).toEqual([{ kind: "text", value: "\n첫 줄\n둘째 줄\n" }]);
  });

  it("treats an unterminated fence as code to the end", () => {
    expect(splitCodeFences("```\ncut off")).toEqual([{ kind: "code", value: "cut off" }]);
  });
});

describe("prettyJson", () => {
  it("formats only text that is entirely a JSON object or array", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("[1]")).toBe("[\n  1\n]");
    expect(prettyJson("답변 {a}")).toBeUndefined();
    expect(prettyJson("{not json}")).toBeUndefined();
    expect(prettyJson("12")).toBeUndefined();
  });
});

describe("list summaries", () => {
  it("says why there is no output rather than leaving a blank", () => {
    expect(outputSummary(preview({ state: "not_captured", kind: "none", text: "" }), 200).text).toBe(
      "응답 본문 미저장",
    );
    expect(outputSummary(preview({ state: "not_captured", kind: "none", text: "" }), 502)).toEqual({
      text: "HTTP 502 오류 (응답 본문 미저장)",
      tone: "danger",
    });
    expect(
      outputSummary(preview({ state: "not_captured", kind: "none", text: "", tool_names: ["lookup"] }), 200)
        .text,
    ).toBe("도구 호출: lookup (응답 본문 미저장)");
    expect(outputSummary(preview({ state: "missing", kind: "none", text: "" }), 403).text).toBe(
      "HTTP 403 · 응답 기록 없음",
    );
    expect(outputSummary(undefined, 200).text).toBe("미리보기 없음");
  });

  it("drops code fence markers from the one-line preview", () => {
    expect(outputSummary(preview({ text: "```sql SELECT 1; ``` 끝" }), 200).text).toBe("SELECT 1; 끝");
  });

  it("marks upstream errors and names tool calls", () => {
    expect(outputSummary(preview({ kind: "error", text: "rate limit" }), 429)).toEqual({
      text: "rate limit",
      tone: "danger",
    });
    expect(outputSummary(preview({ kind: "tool_calls", text: "", tool_names: ["a", "b"] }), 200).text).toBe(
      "도구 호출: a, b",
    );
  });

  it("reports a request with no captured input", () => {
    const missing = preview({});
    missing.input.state = "missing";
    expect(inputSummary(missing).text).toBe("입력 기록 없음");
  });
});

describe("labels", () => {
  it("translates known values and passes unknown ones through", () => {
    expect(requestIORoleLabel("USER")).toBe("사용자");
    expect(requestIORoleLabel("reviewer")).toBe("reviewer");
    expect(requestIORoleLabel("")).toBe("역할 미상");
    expect(requestIOFinishLabel("length")).toBe("길이 제한으로 중단");
    expect(requestIOFinishLabel("custom")).toBe("custom");
  });
});

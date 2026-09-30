import { describe, expect, it } from "vitest";

import {
  confirmedRequestNote,
  requestNoteBody,
  requestNoteDefaults,
  requestNoteFormSchema,
  supportsRequestNoteContract,
} from "./request-note-state";
import { requestNoteSchema } from "@/shared/api/domains/observability.schemas";

const note = {
  request_id: "req-1",
  note: "기존",
  tags: ["태그"],
  created_by: "admin_synthetic",
  updated_at: "2026-01-01T00:00:00Z",
  exists: true,
  redacted_fields: [],
};
describe("요청 메모 앱 계약", () => {
  it.each([undefined, null, "", "bad", "v0.86.15", "v0.86.16-rc.1"])(
    "미확인·구버전 %s를 허용하지 않는다",
    (version) => expect(supportsRequestNoteContract(version)).toBe(false),
  );
  it.each(["v0.86.16", "v0.86.17", "v1.0.0"])("확정 버전 %s를 허용한다", (version) =>
    expect(supportsRequestNoteContract(version)).toBe(true),
  );
  it.each(["exists", "redacted_fields", "note", "tags", "request_id", "created_by", "updated_at"])(
    "필수 %s 누락을 빈 기본값으로 만들지 않는다",
    (field) => {
      const value = Object.fromEntries(Object.entries(note).filter(([name]) => name !== field));
      expect(requestNoteSchema.safeParse(value).success).toBe(false);
    },
  );
  it.each([
    { exists: null },
    { exists: "true" },
    { tags: null },
    { note: null },
    { redacted_fields: null },
    { redacted_fields: ["other"] },
    { redacted_fields: ["note", "note"] },
  ])("잘못된 메타데이터를 거부한다: %j", (invalid) =>
    expect(requestNoteSchema.safeParse({ ...note, ...invalid }).success).toBe(false),
  );
  it("확정 조회·동일 ID만 baseline으로 삼는다", () => {
    const success = { status: "success", fetchStatus: "idle", data: note } as const;
    expect(confirmedRequestNote(success, "req-1")).toEqual(note);
    expect(confirmedRequestNote(success, "req-2")).toBeUndefined();
    for (const state of [
      { ...success, status: "error" as const },
      { ...success, fetchStatus: "fetching" as const },
      { ...success, fetchStatus: "paused" as const },
      { ...success, isInvalidated: true },
    ])
      expect(confirmedRequestNote(state, "req-1")).toBeUndefined();
  });
  it("바꾸지 않은 필드는 원본 길이나 표시 marker를 재저장하지 않는다", () => {
    const baseline = requestNoteSchema.parse({
      ...note,
      note: "x".repeat(2500),
      tags: ["[REDACTED_EMAIL]", "[REDACTED_EMAIL]"],
      redacted_fields: ["tags"],
    });
    const values = requestNoteDefaults(baseline);
    expect(values.tags).toBe("");
    expect(requestNoteBody(values)).toEqual({ preserve_fields: ["note", "tags"] });
    const body = requestNoteBody({ ...values, noteMode: "clear" });
    expect(body).toEqual({ preserve_fields: ["tags"], note: "" });
    expect(Object.isFrozen(body)).toBe(true);
    expect(Object.isFrozen(body.preserve_fields)).toBe(true);
  });
  it("부분 교체와 명시적 비우기만 직렬화한다", () => {
    const values = requestNoteDefaults(requestNoteSchema.parse(note));
    expect(requestNoteBody({ ...values, tagsMode: "replace", tags: " 한글, 새태그 , " })).toEqual({
      preserve_fields: ["note"],
      tags: ["한글", "새태그"],
    });
    expect(requestNoteBody({ ...values, noteMode: "clear", tagsMode: "clear" })).toEqual({
      preserve_fields: [],
      note: "",
      tags: [],
    });
    expect(requestNoteFormSchema.safeParse({ ...values, noteMode: "replace", note: " " }).success).toBe(
      false,
    );
  });
  it.each([",", ", , ,", "#", "# , #", "\u0085", "#\u0085", "\u0085, #\u0085", "#\uFEFF"])(
    "태그 전체 교체 %j가 서버 정리 후 비우기로 바뀌지 않는다",
    (tags) => {
      const values = {
        ...requestNoteDefaults(requestNoteSchema.parse(note)),
        tagsMode: "replace" as const,
        tags,
      };
      const parsed = requestNoteFormSchema.safeParse(values);
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({ path: ["tags"], message: "새 태그를 입력하거나 ‘비우기’를 선택하세요." }),
        );
      expect(() => requestNoteBody(values)).toThrow();
    },
  );
  it.each(["\u0085", " \u0085\t"])("메모 교체 %j도 서버 공백 정리 후 빈 값이면 거부한다", (noteText) => {
    const values = {
      ...requestNoteDefaults(requestNoteSchema.parse(note)),
      noteMode: "replace" as const,
      note: noteText,
    };
    const parsed = requestNoteFormSchema.safeParse(values);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ path: ["note"], message: "새 메모를 입력하거나 ‘비우기’를 선택하세요." }),
      );
    expect(() => requestNoteBody(values)).toThrow();
  });
  it.each(["##", "#한글", "#, 새태그", "\u0085#", "#\uFEFF한글", "#\uFEFF\u0085"])(
    "서버 정리 후 실제 값이 남는 %j는 기존 전송값을 바꾸지 않는다",
    (tags) => {
      const values = {
        ...requestNoteDefaults(requestNoteSchema.parse(note)),
        tagsMode: "replace" as const,
        tags,
      };
      expect(requestNoteFormSchema.safeParse(values).success).toBe(true);
      expect(requestNoteBody(values)).toEqual({
        preserve_fields: ["note"],
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
    },
  );
  it("서버 공백 정리 후 FEFF가 남는 메모의 기존 전송값을 유지한다", () => {
    const noteText = "\u0085\uFEFF\u0085";
    const values = {
      ...requestNoteDefaults(requestNoteSchema.parse(note)),
      noteMode: "replace" as const,
      note: noteText,
    };
    expect(requestNoteFormSchema.safeParse(values).success).toBe(true);
    expect(requestNoteBody(values)).toEqual({ preserve_fields: ["tags"], note: noteText });
  });
  it("유지·비우기는 입력란의 정리 결과와 관계없이 명시된 필드 의미를 보존한다", () => {
    const values = {
      ...requestNoteDefaults(requestNoteSchema.parse(note)),
      tags: "# , \u0085",
      note: "\u0085",
    };
    expect(requestNoteBody(values)).toEqual({ preserve_fields: ["note", "tags"] });
    expect(requestNoteBody({ ...values, tagsMode: "clear" })).toEqual({
      preserve_fields: ["note"],
      tags: [],
    });
    expect(requestNoteBody({ ...values, noteMode: "clear" })).toEqual({
      preserve_fields: ["tags"],
      note: "",
    });
  });
});

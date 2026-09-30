import { describe, expect, it } from "vitest";
import {
  assertTagBaseline,
  assertTagDeleteIdentity,
  displayTagModel,
  modelTagSchema,
  sameTag,
  tagBody,
  tagValues,
  trimTagModel,
} from "./model-tag-state";
import type { ModelUsageTag } from "@/shared/api/schemas";
const row: ModelUsageTag = {
  model: "public-model",
  good_for: "original",
  avoid_for: "",
  risk_note: "",
  updated_by: "actor",
  updated_at: "2026-09-30T00:00:00Z",
};
describe("모델 태그 원문 ID와 고정 기준", () => {
  it("FEFF 실제 문자와 역슬래시 문자 코드 문자열은 화면에서 다르게 표시하고 전송값은 보존", () => {
    const actual = "\ufeffmodel";
    const literal = "\\ufeffmodel";
    expect(displayTagModel(actual)).not.toBe(displayTagModel(literal));
    expect(tagBody({ ...tagValues(row), model: literal }).model).toBe(literal);
    expect(tagBody({ ...tagValues(row), model: actual }).model).toBe(actual);
  });
  for (const model of [".", ".."]) {
    it(`단독 ${model}은 POST 계약을 유지하고 DELETE만 차단`, () => {
      const values = modelTagSchema.parse({ ...tagValues(row), model });
      expect(tagBody(values).model).toBe(model);
      expect(tagBody(values, { ...row, model }).model).toBe(model);
      expect(() => assertTagDeleteIdentity(model)).toThrow();
      expect(new URL(`/admin/model-tags/${encodeURIComponent(model)}`, "http://127.0.0.1").pathname).not.toBe(
        `/admin/model-tags/${encodeURIComponent(model)}`,
      );
    });
  }
  for (const model of ["vendor/../nested", "a/./b", "\ufeff.", "%2e", "\u0085..", ". "]) {
    it(`구분 가능한 ${JSON.stringify(model)} 원문 삭제 경로는 차단하지 않음`, () => {
      expect(() => assertTagDeleteIdentity(model)).not.toThrow();
      const path = `/admin/model-tags/${encodeURIComponent(model)}`;
      expect(new URL(path, "http://127.0.0.1").pathname).toBe(path);
    });
  }
  it("숨은 FEFF/NEL ID 표시는 구별하되 원본 문자열은 변경하지 않는다", () => {
    const original = "\ufeffmodel\u0085";
    expect(displayTagModel(original)).toBe("\\ufeffmodel\\u0085");
    expect(original).toBe("\ufeffmodel\u0085");
  });
  for (const edge of [" ", "\t", "\u0085", "\u00a0", "\u2003", "\u2028", "\u3000"]) {
    it(`Go 공백 U+${edge.codePointAt(0)?.toString(16)}인 신규 ID 정규화/기존 imported ID 수정 거부`, () => {
      const imported = { ...row, model: `${edge}${row.model}${edge}` };
      expect(trimTagModel(imported.model)).toBe(row.model);
      expect(tagBody(tagValues(imported)).model).toBe(row.model);
      expect(() => tagBody(tagValues(imported), imported)).toThrow();
    });
  }
  it("FEFF는 새 추가와 원본 수정 모두 보존하며 편집 model 필드 조작은 무시", () => {
    const opaque = { ...row, model: `\ufeff${row.model}` };
    const values = modelTagSchema.parse(tagValues(opaque));
    expect(tagBody(values).model).toBe(opaque.model);
    expect(tagBody({ ...values, model: "other" }, opaque).model).toBe(opaque.model);
  });
  it("빈 서버 ID를 거부하고 기존 text trim은 diff가 표시할 전송값으로 유지", () => {
    expect(modelTagSchema.safeParse({ ...tagValues(row), model: "\u0085 " }).success).toBe(false);
    expect(modelTagSchema.parse({ ...tagValues(row), good_for: "  revised  " }).good_for).toBe("revised");
  });
  for (const field of ["model", "good_for", "avoid_for", "risk_note", "updated_by", "updated_at"] as const) {
    it(`${field} 변경은 고정 기준과 불일치`, () => {
      const changed = { ...row, [field]: "changed" };
      expect(sameTag(row, { ...row })).toBe(true);
      expect(sameTag(row, changed)).toBe(false);
      expect(() => assertTagBaseline([changed], row.model, row)).toThrow();
    });
  }
  it("현재 빈 목록은 추가만 허용, 삭제된 수정 대상과 새로 생긴 추가 대상은 거부", () => {
    expect(() => assertTagBaseline([], row.model, undefined)).not.toThrow();
    expect(() => assertTagBaseline([], row.model, row)).toThrow();
    expect(() => assertTagBaseline([row], row.model, undefined)).toThrow();
  });
});

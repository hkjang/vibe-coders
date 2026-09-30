import { z } from "zod";
import { AppError } from "@/shared/api/error";
import type { ModelUsageTag } from "@/shared/api/schemas";

// Go strings.TrimSpace uses Unicode White_Space: NEL is included, FEFF is not.
export const trimTagModel = (model: string): string =>
  model.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
/** Display only: make opaque ID whitespace visible without changing the payload. */
export const displayTagModel = (model: string): string =>
  model
    .replaceAll("\\", "\\\\")
    .replace(
      /[\p{White_Space}\uFEFF]/gu,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
export const modelTagSchema = z.object({
  model: z
    .string()
    .min(1, "모델 이름을 입력하세요.")
    .max(256, "모델 이름은 256자 이내로 입력하세요.")
    .refine((value) => trimTagModel(value).length > 0, "모델 이름을 입력하세요."),
  good_for: z.string().trim().max(512, "적합한 작업은 512자 이내로 입력하세요."),
  avoid_for: z.string().trim().max(512, "피해야 할 작업은 512자 이내로 입력하세요."),
  risk_note: z.string().trim().max(1000, "위험 메모는 1000자 이내로 입력하세요."),
});
export type ModelTagValues = z.infer<typeof modelTagSchema>;
export const emptyTag: ModelTagValues = { model: "", good_for: "", avoid_for: "", risk_note: "" };
export const tagFields = [
  ["model", "모델"],
  ["good_for", "적합한 작업"],
  ["avoid_for", "피해야 할 작업"],
  ["risk_note", "위험 메모"],
] as const;
export const tagIdentityReason =
  "이 모델 ID는 저장 시 다른 ID로 정규화됩니다. 수정은 차단됩니다. 원본 ID 삭제는 별도로 확인할 수 있습니다.";
export const tagListReason = "최신 태그 목록을 정상 조회한 뒤 다시 검토하세요.";
export function tagDeleteIdentityReason(model: string): string | undefined {
  return model === "." || model === ".."
    ? "이 모델 ID는 브라우저가 삭제 URL을 다른 경로로 바꾸므로 원본 삭제 경로를 안전하게 표현할 수 없습니다. 이 화면에서는 삭제할 수 없습니다."
    : undefined;
}
export function assertTagDeleteIdentity(model: string): void {
  const reason = tagDeleteIdentityReason(model);
  if (reason) throw new AppError(reason, { kind: "contract" });
}
export function tagValues(row?: ModelUsageTag): ModelTagValues {
  return row
    ? { model: row.model, good_for: row.good_for, avoid_for: row.avoid_for, risk_note: row.risk_note }
    : { ...emptyTag };
}
export function tagBody(values: ModelTagValues, original?: ModelUsageTag): ModelTagValues {
  if (original && trimTagModel(original.model) !== original.model)
    throw new AppError(tagIdentityReason, { kind: "contract" });
  return { ...values, model: original?.model ?? trimTagModel(values.model) };
}
export function sameTag(a: ModelUsageTag | undefined, b: ModelUsageTag | undefined): boolean {
  return a === undefined || b === undefined
    ? a === b
    : tagFields.every(([key]) => a[key] === b[key]) &&
        a.updated_by === b.updated_by &&
        a.updated_at === b.updated_at;
}
export function assertTagBaseline(rows: ModelUsageTag[], model: string, baseline: ModelUsageTag | undefined) {
  const current = rows.find((row) => row.model === model);
  if (!sameTag(current, baseline))
    throw new AppError(
      "대상 태그가 변경되거나 삭제되었습니다. 목록을 다시 조회하고 최신 기준을 확인하세요.",
      { kind: "contract" },
    );
}

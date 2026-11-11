import { z } from "zod";
import {
  promptAssetSchema,
  promptAssetHistorySchema,
  promptAssetUsageSchema,
  savedFilterSchema,
  promptSearchResponseSchema,
  fingerprintResponseSchema,
  promptDebtResponseSchema,
} from "@/shared/api/domains/prompts";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

export const libraryRouteId = "prompts.library";
export const hiddenLibraryText = "민감한 내용은 숨겼습니다.";
export const libraryNumber = (value: number | undefined | null, digits = 0) =>
  value === undefined || value === null ? "—" : formatNumber(value, digits);
export const libraryCost = (value: number | undefined | null) =>
  value === undefined || value === null ? "—" : formatKRW(value);
export const libraryPercent = (value: number | undefined | null) =>
  value === undefined || value === null ? "—" : formatPercent(value);
export function libraryError(code: "changed" | "unknown" | "busy" | "invalid" | "exists" = "invalid") {
  return new AppError("보관함 작업을 다시 확인하세요.", { kind: "contract", code: `prompt_library_${code}` });
}
export function libraryID(id: string, prefixes: readonly string[]): boolean {
  return (
    id.length > 0 &&
    id.length <= 512 &&
    id.trim() === id &&
    !Array.from(id).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    !containsPotentialSecret(id, prefixes)
  );
}
export function safeLibraryError(error: unknown, prefixes: readonly string[]) {
  return new AppError(safeAppErrorMessage(error, "프롬프트 보관함 작업을 완료하지 못했습니다."), {
    kind: isAppError(error) ? error.kind : "network",
    status: isAppError(error) ? error.status : undefined,
    code: isAppError(error) && error.code?.startsWith("prompt_library_") ? error.code : undefined,
    requestId:
      isAppError(error) && error.requestId && libraryID(error.requestId, prefixes)
        ? error.requestId
        : undefined,
  });
}

// Project only declared fields before Query cache. Templates are saved content,
// not captured redacted prompts. Credential-shaped text is masked for display.
function mask(value: unknown, prefixes: readonly string[]): unknown {
  if (typeof value === "string") return containsPotentialSecret(value, prefixes) ? hiddenLibraryText : value;
  if (Array.isArray(value)) return value.map((item: unknown) => mask(item, prefixes));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item, prefixes)]));
  return value;
}
export function projectLibrary<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  prefixes: readonly string[],
): z.output<Schema> {
  const parsed = schema.parse(value);
  return mask(parsed, prefixes) as z.output<Schema>;
}
export function assertLibraryIDs(rows: readonly { id: string }[], prefixes: readonly string[]) {
  if (
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.some((row) => !libraryID(row.id, prefixes))
  )
    throw libraryError();
}
export const libraryAssetSchema = promptAssetSchema.strip();
export const libraryHistorySchema = promptAssetHistorySchema.strip();
export const libraryUsageSchema = promptAssetUsageSchema.strip();
export const libraryFilterSchema = savedFilterSchema.strip();
const request = promptSearchResponseSchema.shape.requests.unwrap().unwrap().element;
export const librarySearchSchema = z.object({
  requests: z
    .array(
      request.strip().extend({
        languages: z.array(request.shape.languages.unwrap().unwrap().element.strip()).nullish(),
        prompts: z.array(request.shape.prompts.unwrap().unwrap().element.strip()).nullish(),
      }),
    )
    .nullish(),
});
export const libraryFingerprintSchema = z.object({
  fingerprints: z
    .array(fingerprintResponseSchema.shape.fingerprints.unwrap().unwrap().element.strip())
    .nullish(),
});
export const libraryDebtSchema = promptDebtResponseSchema.strip().extend({
  items: z.array(promptDebtResponseSchema.shape.items.unwrap().unwrap().element.strip()).nullish(),
});

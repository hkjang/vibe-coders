import { z } from "zod";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export const registryFileLimit = 2 * 1024 * 1024;
const name = z.string().trim().min(1);
const table = z
  .object({
    schema_name: name,
    table_name: name,
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();
const column = table
  .omit({ enabled: true })
  .extend({
    column_name: name,
    data_type: z.string().optional(),
    sensitivity: z.enum(["", "normal", "mask", "aggregate_only", "approval_required", "exclude"]).optional(),
  })
  .passthrough();
const bundle = z
  .object({
    version: z.literal(1).optional(),
    schema: z.string().optional(),
    tables: z.array(table).max(10000).default([]),
    columns: z.array(column).max(10000).default([]),
  })
  .strict()
  .refine((value) => value.tables.length + value.columns.length > 0);

export async function readRegistryFile(file: File) {
  if (!/\.json$/iu.test(file.name) || file.size === 0 || file.size > registryFileLimit)
    throw new AppError("레지스트리 파일 제한", { kind: "contract", code: "t2s_file_size" });
  try {
    return bundle.parse(JSON.parse(await file.text()));
  } catch {
    throw new AppError("레지스트리 파일 형식", { kind: "contract", code: "t2s_file_format" });
  }
}

export function registryActionError(error: unknown, fallback: string): string {
  if (isAppError(error)) {
    if (error.code === "t2s_file_size") return "내용이 있는 2MB 이하의 JSON 파일을 선택하세요.";
    if (error.code === "t2s_file_format")
      return "JSON 형식을 확인하세요. 테이블·컬럼 배열과 각 항목의 스키마·이름이 필요합니다.";
  }
  return safeAppErrorMessage(error, fallback);
}

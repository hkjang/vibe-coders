import { z } from "zod";
import type { GetAdminText2SqlData, Text2SqlSchemaDetailResponse } from "@/shared/api/generated";
import { operation, type WithQuery } from "@/shared/api/endpoint-factory";

export const text2sqlSchemaDetailSchema = z
  .strictObject({
    raw_content_available: z.boolean(),
    schema: z.strictObject({
      name: z.string(),
      team: z.string(),
      dialect: z.string(),
      schema_text: z.string(),
      allowed_tables: z.array(z.string()),
      is_default: z.boolean(),
      enabled: z.boolean(),
      version: z.number().int(),
      collected_at: z.string(),
      source_fingerprint: z.string(),
      updated_at: z.string(),
    }),
  })
  .refine(
    (data) =>
      data.raw_content_available ||
      (data.schema.schema_text === "[sensitive-content-omitted]" && data.schema.allowed_tables.length === 0),
    "민감한 스키마 정보의 조회 권한을 확인하지 못했습니다.",
  ) satisfies z.ZodType<Text2SqlSchemaDetailResponse>;

export const text2sqlSchemaDetailEndpoint = operation<
  WithQuery<GetAdminText2SqlData, { view: "schema"; name: string }>,
  Text2SqlSchemaDetailResponse
>()(
  "GET",
  "/admin/text2sql",
  text2sqlSchemaDetailSchema,
  z.strictObject({ view: z.literal("schema"), name: z.string().min(1) }),
);

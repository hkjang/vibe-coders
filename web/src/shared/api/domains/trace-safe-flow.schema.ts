import { z } from "zod";

/** Preserve the original nanoseconds; Date is used only to reject invalid calendar dates. */
export const flowTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/u)
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
  });
const requestRef = z.string().regex(/^req_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{21}$/u);
const spanRef = z.string().regex(/^span_[A-Za-z0-9_-]{43}$/u);
const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const traceSafeFlowQuerySchema = z
  .object({ request_ref: requestRef, created_at: flowTimestampSchema })
  .strict();
export type TraceSafeFlowQuery = z.infer<typeof traceSafeFlowQuerySchema>;
const coverage = z
  .object({ limit: z.literal(100), truncated: z.boolean(), omitted: z.number().int().min(0).max(100) })
  .strict();
const span = z
  .object({
    span_ref: spanRef,
    parent_ref: spanRef.nullable(),
    kind: z.enum(["request", "text2sql", "tool", "mcp_tool"]),
    name: z
      .string()
      .min(1)
      .refine((value) => new TextEncoder().encode(value).length <= 256),
    status: z.enum(["ok", "error", "skipped", "unknown"]),
    recorded_at: flowTimestampSchema.nullable(),
    offset_ms: safeInteger.nullable(),
    duration_ms: safeInteger.nonnegative().nullable(),
  })
  .strict();
export const traceSafeFlowSchema = z
  .object({
    flow_version: z.literal(1),
    request_ref: requestRef,
    created_at: flowTimestampSchema,
    generated_at: flowTimestampSchema,
    spans: z.array(span).min(1).max(201),
    coverage: z.object({ tools: coverage, text2sql: coverage }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const root = value.spans[0];
    const refs = new Set<string>();
    let tools = 0;
    let text2sql = 0;
    const invalid = () =>
      context.addIssue({ code: "custom", message: "요청 단계 응답 구조를 확인할 수 없습니다." });
    if (root?.recorded_at !== value.created_at || root?.offset_ms !== 0) invalid();
    for (const [index, row] of value.spans.entries()) {
      if (refs.has(row.span_ref)) invalid();
      refs.add(row.span_ref);
      if (
        index === 0
          ? row.kind !== "request" || row.parent_ref !== null
          : row.kind === "request" || row.parent_ref !== root?.span_ref
      )
        invalid();
      if (row.recorded_at === null && row.offset_ms !== null) invalid();
      if (row.kind === "tool" || row.kind === "mcp_tool") {
        tools += 1;
        if (row.duration_ms !== null) invalid();
      }
      if (row.kind === "text2sql") text2sql += 1;
    }
    if (tools + value.coverage.tools.omitted > 100 || text2sql + value.coverage.text2sql.omitted > 100)
      invalid();
  });
export type TraceSafeFlow = z.infer<typeof traceSafeFlowSchema>;

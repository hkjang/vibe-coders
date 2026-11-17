import { z } from "zod";
import type {
  GetAdminRedteamResultsIdEvidenceData,
  GetAdminRedteamRunsIdResultsData,
  RedTeamEvidenceRead,
  RedTeamResultsRead,
} from "@/shared/api/generated";
import { operation, type WithQuery } from "@/shared/api/endpoint-factory";
import { runMetadataSchema } from "./redteam-run-page";

const text = z.string();
const count = z.number().int().nonnegative();
const metadata = z.strictObject({
  target: text.optional(),
  provider: text.optional(),
  model: text.optional(),
  pack: text.optional(),
  mode: text.optional(),
  expected: text.optional(),
  session_id: text.optional(),
  "x-cost-center": text.optional(),
  source_result_id: text.optional(),
  source_run_id: text.optional(),
  review_id: text.optional(),
  "x-redteam": z.boolean().optional(),
  simulated: z.boolean().optional(),
  http_status: z.number().nonnegative().optional(),
  latency_ms: z.number().nonnegative().optional(),
  cost_krw: z.number().nonnegative().optional(),
  leak_findings: z.array(text).optional(),
});
const evidence = z.strictObject({
  id: text.min(1),
  result_id: text.min(1),
  masked_prompt: text,
  masked_response: text,
  raw_prompt: text.optional(),
  raw_response: text.optional(),
  tool_calls: z.array(z.record(z.string(), z.unknown())),
  headers_summary: metadata,
  export_hash: text,
  created_at: text,
});
export const evidenceReadSchema = z
  .strictObject({
    evidence,
    masked: z.boolean(),
    raw_allowed: z.boolean(),
    raw_available: z.boolean(),
    tool_call_count: count,
  })
  .superRefine((value, ctx) => {
    const { evidence: record } = value;
    if (
      (value.masked && (record.raw_prompt || record.raw_response || record.tool_calls.length)) ||
      (!value.masked && (!value.raw_allowed || record.tool_calls.length !== value.tool_call_count))
      // Raw availability is independent of permission, and never a reveal grant.
    )
      ctx.addIssue({ code: "custom", message: "증적 표시 범위를 확인하지 못했습니다." });
  }) satisfies z.ZodType<RedTeamEvidenceRead>;

const caseResult = z.strictObject({
  id: text.min(1),
  run_id: text.min(1),
  case_id: text,
  request_id: text,
  decision: text,
  severity: text,
  evidence_hash: text,
  policy_decision: text,
  latency_ms: count,
  cost_krw: z.number().nonnegative(),
  created_at: text,
});
export const resultsReadSchema = z
  .strictObject({
    run: runMetadataSchema,
    results: z.array(caseResult),
    prompts: z.record(z.string(), text),
    count,
    masked: z.literal(true),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.results.map((result) => result.id));
    if (
      value.count !== value.results.length ||
      ids.size !== value.count ||
      value.results.some((result) => result.run_id !== value.run.id) ||
      Object.keys(value.prompts).some((id) => !ids.has(id))
    ) {
      ctx.addIssue({ code: "custom", message: "실행 결과 응답을 확인하지 못했습니다." });
    }
  }) satisfies z.ZodType<RedTeamResultsRead>;

const evidenceQuery = z.strictObject({ view: z.literal("app"), reveal: z.literal("raw").optional() });
const resultsQuery = z.strictObject({ view: z.literal("app") });
export const evidenceReadEndpoint = operation<
  WithQuery<GetAdminRedteamResultsIdEvidenceData, z.infer<typeof evidenceQuery>>,
  RedTeamEvidenceRead
>()("GET", "/admin/redteam/results/{id}/evidence", evidenceReadSchema, evidenceQuery);
export const resultsReadEndpoint = operation<
  WithQuery<GetAdminRedteamRunsIdResultsData, z.infer<typeof resultsQuery>>,
  RedTeamResultsRead
>()("GET", "/admin/redteam/runs/{id}/results", resultsReadSchema, resultsQuery);
export type EvidenceRead = z.output<typeof evidenceReadSchema>;

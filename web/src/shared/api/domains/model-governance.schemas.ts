import { z } from "zod";

// These APIs always return complete stored rows and explicit arrays. Missing,
// null or malformed data is unconfirmed, never an empty list or a zero threshold.
// Unknown extra fields remain forward-compatible and are stripped by Zod.
export const modelContractSchema = z.object({
  id: z.string(),
  name: z.string(),
  task_type: z.string(),
  min_quality_score: z.number().finite(),
  min_golden_pass_rate: z.number().finite(),
  min_success_rate: z.number().finite(),
  max_latency_ms: z.number().int(),
  max_avg_cost_krw: z.number().finite(),
  enabled: z.boolean(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const modelContractListSchema = z.object({ contracts: z.array(modelContractSchema) });
export const modelContractSaveSchema = z.object({ id: z.string(), ok: z.literal(true) });
export const modelContractDeleteSchema = z.object({ ok: z.literal(true) });

export const modelContractRunSchema = z.object({
  model: z.string(),
  window: z.string(),
  replaceable: z.boolean(),
  note: z.string(),
  have_metrics: z.object({ quality: z.boolean(), latency: z.boolean(), cost: z.boolean() }),
  results: z.array(
    z.object({
      contract_id: z.string(),
      contract_name: z.string(),
      task_type: z.string(),
      verdict: z.enum(["pass", "warn", "fail", "no_data"]),
      replaceable: z.boolean(),
      checks: z.array(
        z.object({
          dimension: z.string(),
          threshold: z.number().finite(),
          actual: z.number().finite().nullable(),
          status: z.enum(["pass", "warn", "fail", "no_data", "skip"]),
        }),
      ),
    }),
  ),
  failing_samples: z.array(z.object({ fingerprint: z.string(), reason: z.string() })),
});

export const modelDeprecationSchema = z.object({
  id: z.string(),
  model_glob: z.string(),
  replacement: z.string(),
  sunset_date: z.string(),
  message: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const modelDeprecationListSchema = z.object({ deprecations: z.array(modelDeprecationSchema) });
export const modelDeprecationSaveSchema = z.object({ deprecation: modelDeprecationSchema });
export const modelDeprecationDeleteSchema = z.object({ id: z.string(), deleted: z.literal(true) });

export type ModelContract = z.output<typeof modelContractSchema>;
export type ModelContractRun = z.output<typeof modelContractRunSchema>;
export type ModelDeprecation = z.output<typeof modelDeprecationSchema>;

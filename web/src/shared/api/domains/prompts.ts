// prompts domain endpoints. Declare every server call this domain's screens make
// here with `operation()` from "@/shared/api/endpoint-factory" and a zod schema
// (see "@/shared/api/loose" for legacy responses without a documented shape).
import { z } from "zod";

import { operation, type WithBody, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  DeleteAdminSavedFiltersIdData,
  DeleteAdminTemplatesIdData,
  GetAdminPromptAssetsData,
  GetAdminPromptsData,
  GetAdminPromptsDebtData,
  GetAdminPromptsFingerprintsData,
  GetAdminSavedFiltersData,
  GetAdminTemplatesIdHistoryData,
  GetAdminTemplatesIdUsageData,
  PatchAdminTemplatesIdData,
  PostAdminSavedFiltersData,
  PostAdminTemplatesData,
  PostAdminTemplatesIdApproveData,
  PostAdminTemplatesIdRollbackData,
  PostAdminTemplatesIdSubmitData,
  PostAdminTemplatesIdUseData,
} from "@/shared/api/generated";
import { looseList, looseObject, numberish } from "@/shared/api/loose";

// ---------- prompt search (legacy `#/prompts`) ----------

const promptSearchQuerySchema = z.object({
  q: z.string().optional(),
  api_key_id: z.string().optional(),
  ip: z.string().optional(),
  language: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().int().positive().max(10_000).optional(),
});
export type PromptSearchQuery = z.infer<typeof promptSearchQuerySchema>;

// `/admin/prompts` reuses the recent-request row; only the fields the list renders
// are declared. Prompt text arrives already redacted by the server.
const promptSearchResponseSchema = looseObject({
  requests: looseList({
    id: z.string(),
    created_at: z.string().optional(),
    api_key_id: z.string().optional(),
    client_ip: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    endpoint: z.string().optional(),
    status_code: numberish.optional(),
    latency_ms: numberish.optional(),
    total_tokens: numberish.optional(),
    estimated_cost: numberish.optional(),
    session_id: z.string().optional(),
    prompt_name: z.string().optional(),
    error: z.string().optional(),
    languages: z
      .array(z.looseObject({ language: z.string().optional(), lines: numberish.optional() }))
      .nullish(),
    prompts: z
      .array(
        z.looseObject({
          role: z.string().optional(),
          redacted_text: z.string().optional(),
          language_hint: z.string().optional(),
        }),
      )
      .nullish(),
  }).nullish(),
});

const fingerprintQuerySchema = z.object({
  window: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type PromptFingerprintQuery = z.infer<typeof fingerprintQuerySchema>;

const fingerprintResponseSchema = looseObject({
  fingerprints: looseList({
    fingerprint: z.string().optional(),
    task_type: z.string().optional(),
    requests: numberish.optional(),
    avg_cost_krw: numberish.optional(),
    total_cost_krw: numberish.optional(),
    avg_tokens: numberish.optional(),
    success_rate: numberish.optional(),
    distinct_models: numberish.optional(),
    top_model: z.string().optional(),
    cheapest_model: z.string().optional(),
    sample_prompt: z.string().optional(),
    last_seen: z.string().optional(),
  }).nullish(),
});

// ---------- prompt debt (legacy hidden `#/prompt-debt`) ----------

const promptDebtQuerySchema = z.object({
  window: z.string().optional(),
  min_requests: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type PromptDebtQuery = z.infer<typeof promptDebtQuerySchema>;

const promptDebtResponseSchema = looseObject({
  since: z.string().optional(),
  count: numberish.optional(),
  total_debt_cost_krw: numberish.optional(),
  note: z.string().optional(),
  items: looseList({
    fingerprint: z.string().optional(),
    task_type: z.string().optional(),
    requests: numberish.optional(),
    success_rate: numberish.optional(),
    avg_cost_krw: numberish.optional(),
    total_cost_krw: numberish.optional(),
    top_model: z.string().optional(),
    cheaper_model: z.string().optional(),
    debt_score: numberish.optional(),
    debt_type: z.string().optional(),
    action: z.string().optional(),
    sample_prompt: z.string().optional(),
    last_seen: z.string().optional(),
  }).nullish(),
});

// ---------- prompt assets (legacy `#/prompt-assets`) ----------

const promptAssetQuerySchema = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  category: z.string().optional(),
  tag: z.string().optional(),
});
export type PromptAssetQuery = z.infer<typeof promptAssetQuerySchema>;

const promptAssetSchema = looseObject({
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
  enabled: z.boolean().optional(),
  use_count: numberish.optional(),
  last_used_at: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  tags: z.array(z.string()).nullish(),
  status: z.string().optional(),
  approved_by: z.string().optional(),
  approved_at: z.string().optional(),
  note: z.string().optional(),
  success_rate: numberish.optional(),
  avg_cost_krw: numberish.optional(),
  avg_latency_ms: numberish.optional(),
  call_count: numberish.optional(),
});
export type PromptAsset = z.infer<typeof promptAssetSchema>;

const labelledKeySchema = looseObject({ key: z.string(), label: z.string().optional() });

const promptAssetListSchema = looseObject({
  assets: z.array(promptAssetSchema).nullish(),
  stats: z.record(z.string(), numberish).nullish(),
  categories: z.array(labelledKeySchema).nullish(),
  known_tags: z.array(labelledKeySchema).nullish(),
});

export interface PromptAssetSaveBody {
  readonly id?: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  /** Prompt text. Sent in the request body only — never in a URL or storage. */
  readonly body: string;
  readonly tags: readonly string[];
  readonly status?: string;
  readonly enabled?: boolean;
  readonly note?: string;
}

const promptAssetSaveResponseSchema = looseObject({ template: promptAssetSchema.optional() });
const deleteAcknowledgementSchema = looseObject({ id: z.string().optional(), status: z.string().optional() });

/** Partial edit of an existing asset (`PATCH /admin/templates/{id}`). */
export interface PromptAssetUpdateBody {
  readonly name?: string;
  readonly category?: string;
  readonly description?: string;
  /** Prompt text. Sent in the request body only — never in a URL or storage. */
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly enabled?: boolean;
  readonly note?: string;
}

/** Review decision: `approved`, `standard` (promote) or `draft` (reject). */
export interface PromptAssetApproveBody {
  readonly status: string;
  readonly note: string;
}

export interface PromptAssetRollbackBody {
  readonly version: number;
}

/** `store.PromptTemplateHistory` — one entry of an asset's change log. */
const promptAssetHistorySchema = looseObject({
  id: z.string(),
  template_id: z.string().optional(),
  action: z.string().optional(),
  version_num: numberish.optional(),
  name: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).nullish(),
  from_status: z.string().optional(),
  to_status: z.string().optional(),
  note: z.string().optional(),
  actor: z.string().optional(),
  has_snapshot: z.boolean().optional(),
  created_at: z.string().optional(),
});
export type PromptAssetHistoryEntry = z.infer<typeof promptAssetHistorySchema>;

const promptAssetHistoryListSchema = looseObject({
  history: z.array(promptAssetHistorySchema).nullish(),
});

/** `store.PromptAssetUsageRow` — per-team usage over the last 90 days. */
const promptAssetUsageSchema = looseObject({
  team: z.string(),
  calls: numberish.optional(),
  errors: numberish.optional(),
  cost_krw: numberish.optional(),
});
export type PromptAssetUsageRow = z.infer<typeof promptAssetUsageSchema>;

const promptAssetUsageListSchema = looseObject({ usage: z.array(promptAssetUsageSchema).nullish() });

// `/use` returns the asset body and records a usage; the body stays in memory.
const promptAssetUseSchema = looseObject({
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).nullish(),
  status: z.string().optional(),
});

const promptAssetStatusSchema = looseObject({ id: z.string().optional(), status: z.string().optional() });

const promptAssetRollbackSchema = looseObject({
  template: promptAssetSchema.optional(),
  restored_from: numberish.optional(),
});

// ---------- saved filters (shared with the legacy prompt search toolbar) ----------

const savedFilterQuerySchema = z.object({ view: z.string().optional() });
export type SavedFilterQuery = z.infer<typeof savedFilterQuerySchema>;

const savedFilterSchema = looseObject({
  id: z.string(),
  name: z.string().optional(),
  view: z.string().optional(),
  params: z.string().optional(),
  created_by: z.string().optional(),
  created_at: z.string().optional(),
});
export type SavedFilter = z.infer<typeof savedFilterSchema>;

const savedFilterListSchema = looseObject({ filters: z.array(savedFilterSchema).nullish() });
const savedFilterCreateSchema = looseObject({ filter: savedFilterSchema.optional() });

export interface SavedFilterCreateBody {
  readonly name: string;
  readonly view: string;
  /** Raw query string of the current filter form (never contains credentials). */
  readonly params: string;
}

export const promptsEndpoints = {
  search: operation<WithQuery<GetAdminPromptsData, PromptSearchQuery>, unknown>()(
    "GET",
    "/admin/prompts",
    promptSearchResponseSchema,
    promptSearchQuerySchema,
  ),
  fingerprints: operation<WithQuery<GetAdminPromptsFingerprintsData, PromptFingerprintQuery>, unknown>()(
    "GET",
    "/admin/prompts/fingerprints",
    fingerprintResponseSchema,
    fingerprintQuerySchema,
  ),
  debt: operation<WithQuery<GetAdminPromptsDebtData, PromptDebtQuery>, unknown>()(
    "GET",
    "/admin/prompts/debt",
    promptDebtResponseSchema,
    promptDebtQuerySchema,
  ),
  assets: {
    list: operation<WithQuery<GetAdminPromptAssetsData, PromptAssetQuery>, unknown>()(
      "GET",
      "/admin/prompt-assets",
      promptAssetListSchema,
      promptAssetQuerySchema,
    ),
    // POST upserts by slug id, so the same call creates and edits an asset.
    save: operation<WithBody<PostAdminTemplatesData, PromptAssetSaveBody>, unknown>()(
      "POST",
      "/admin/templates",
      promptAssetSaveResponseSchema,
    ),
    // PATCH applies a partial edit; omitted fields keep their stored value.
    update: operation<WithBody<PatchAdminTemplatesIdData, PromptAssetUpdateBody>, unknown>()(
      "PATCH",
      "/admin/templates/{id}",
      promptAssetSaveResponseSchema,
    ),
    remove: operation<DeleteAdminTemplatesIdData, unknown>()(
      "DELETE",
      "/admin/templates/{id}",
      deleteAcknowledgementSchema,
    ),
    submit: operation<PostAdminTemplatesIdSubmitData, unknown>()(
      "POST",
      "/admin/templates/{id}/submit",
      promptAssetStatusSchema,
    ),
    approve: operation<WithBody<PostAdminTemplatesIdApproveData, PromptAssetApproveBody>, unknown>()(
      "POST",
      "/admin/templates/{id}/approve",
      promptAssetStatusSchema,
    ),
    rollback: operation<WithBody<PostAdminTemplatesIdRollbackData, PromptAssetRollbackBody>, unknown>()(
      "POST",
      "/admin/templates/{id}/rollback",
      promptAssetRollbackSchema,
    ),
    use: operation<PostAdminTemplatesIdUseData, unknown>()(
      "POST",
      "/admin/templates/{id}/use",
      promptAssetUseSchema,
    ),
    history: operation<GetAdminTemplatesIdHistoryData, unknown>()(
      "GET",
      "/admin/templates/{id}/history",
      promptAssetHistoryListSchema,
    ),
    usage: operation<GetAdminTemplatesIdUsageData, unknown>()(
      "GET",
      "/admin/templates/{id}/usage",
      promptAssetUsageListSchema,
    ),
  },
  savedFilters: {
    list: operation<WithQuery<GetAdminSavedFiltersData, SavedFilterQuery>, unknown>()(
      "GET",
      "/admin/saved-filters",
      savedFilterListSchema,
      savedFilterQuerySchema,
    ),
    create: operation<WithBody<PostAdminSavedFiltersData, SavedFilterCreateBody>, unknown>()(
      "POST",
      "/admin/saved-filters",
      savedFilterCreateSchema,
    ),
    remove: operation<DeleteAdminSavedFiltersIdData, unknown>()(
      "DELETE",
      "/admin/saved-filters/{id}",
      deleteAcknowledgementSchema,
    ),
  },
} as const;

export type PromptSearchResult = z.infer<typeof promptSearchResponseSchema>;
export type PromptFingerprintResult = z.infer<typeof fingerprintResponseSchema>;
export type PromptDebtResult = z.infer<typeof promptDebtResponseSchema>;
export type PromptAssetListResult = z.infer<typeof promptAssetListSchema>;
export type PromptAssetHistoryResult = z.infer<typeof promptAssetHistoryListSchema>;
export type PromptAssetUsageResult = z.infer<typeof promptAssetUsageListSchema>;

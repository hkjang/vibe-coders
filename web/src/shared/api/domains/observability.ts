// observability domain endpoints. Declare every server call this domain's screens make
// here with `operation()` from "@/shared/api/endpoint-factory" and a zod schema
// (see "@/shared/api/loose" for legacy responses without a documented shape).
import { z } from "zod";

import {
  capabilitiesResponseSchema,
  flightRecorderResponseSchema,
  flowMapResponseSchema,
  journeyProbeResponseSchema,
  llmEvaluationsResponseSchema,
  llmFeedbackCreatedSchema,
  llmFeedbackResponseSchema,
  llmInsightsResponseSchema,
  llmPatternsResponseSchema,
  llmPromptCompareResponseSchema,
  llmPromptsResponseSchema,
  llmSessionTimelineSchema,
  llmSessionsResponseSchema,
  llmTraceDetailSchema,
  llmTimeseriesResponseSchema,
  podsResponseSchema,
  requestAnalysisSchema,
  requestExplainSchema,
  requestNoteDeletedSchema,
  requestNoteSchema,
  requestReplaySchema,
  savedFilterDeletedSchema,
  savedFilterEnvelopeSchema,
  savedFilterListSchema,
  scatterResponseSchema,
  sessionListResponseSchema,
  waterfallResponseSchema,
  xviewDeltaResponseSchema,
  xviewModelOutliersResponseSchema,
  xviewModelSeriesResponseSchema,
  xviewModelsResponseSchema,
} from "@/shared/api/domains/observability.schemas";
import { operation, type WithBody, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  DeleteAdminRequestsIdNoteData,
  DeleteAdminSavedFiltersIdData,
  GetAdminCapabilitiesData,
  GetAdminFlowMapData,
  GetAdminLlmEvaluationsData,
  GetAdminLlmFeedbackData,
  GetAdminLlmInsightsData,
  GetAdminLlmPatternsData,
  GetAdminLlmPromptsCompareData,
  GetAdminLlmPromptsData,
  GetAdminLlmSessionData,
  GetAdminLlmSessionsData,
  GetAdminLlmTimeseriesData,
  GetAdminLlmTracesIdData,
  GetAdminPodsData,
  GetAdminRequestsIdExplainData,
  GetAdminRequestsIdNoteData,
  GetAdminSavedFiltersData,
  GetAdminScatterData,
  GetAdminSessionsData,
  GetAdminSessionsSessionIdFlightRecorderData,
  GetAdminWaterfallData,
  GetAdminXviewDeltaData,
  GetAdminXviewModelOutliersData,
  GetAdminXviewModelSeriesData,
  GetAdminXviewModelsData,
  PatchAdminSavedFiltersIdData,
  PostAdminJourneyProbeData,
  PostAdminLlmFeedbackData,
  PostAdminRequestsIdAnalyzeData,
  PostAdminRequestsIdReplayData,
  PostAdminSavedFiltersData,
  PutAdminRequestsIdNoteData,
} from "@/shared/api/generated";

// The legacy admin surface is documented without request/response schemas, so the
// generated response type is `unknown` and the zod schemas above are the contract.

export interface SavedFilterCreateBody {
  view: string;
  name: string;
  /** URL-encoded query string; validateSavedFilterParams() rejects unknown xview keys. */
  params: string;
}

export interface SavedFilterUpdateBody {
  name?: string;
  params?: string;
}

export interface LLMFeedbackBody {
  request_id: string;
  trace_id?: string;
  rating: number;
  label?: string;
  comment?: string;
  source?: string;
}

export interface JourneyProbeBody {
  proxy_key: string;
  clients?: string[];
}

/** Body of `PUT /admin/requests/{id}/note` (see `handleRequestNote`). */
export interface RequestNoteBody {
  /** Operator labels; the server strips `#` and commas and de-duplicates. */
  tags: readonly string[];
  note: string;
}

const optionalString = z.string().optional();
const optionalNumber = z.number().optional();

/** Shared XView range/filter parameters (xviewTimeRange + scatterFilterFromRequest). */
const xviewRangeQuerySchema = z.object({
  window: optionalString,
  from: optionalString,
  to: optionalString,
  tz: optionalString,
  models: optionalString,
  endpoint: optionalString,
  api_key_id: optionalString,
});

const scatterQuerySchema = xviewRangeQuerySchema.extend({
  limit: optionalNumber,
  include_summary: z.boolean().optional(),
  group_by: optionalString,
});
export type ScatterQuery = z.infer<typeof scatterQuerySchema>;

const xviewDeltaQuerySchema = xviewRangeQuerySchema.extend({
  after_ingested_at: optionalString,
  after_request_id: optionalString,
  reconcile: z.boolean().optional(),
  refresh: z.boolean().optional(),
  limit: optionalNumber,
});
export type XViewDeltaQuery = z.infer<typeof xviewDeltaQuerySchema>;

const xviewModelsQuerySchema = xviewRangeQuerySchema.extend({ top: optionalNumber });
export type XViewModelsQuery = z.infer<typeof xviewModelsQuerySchema>;

const xviewSeriesQuerySchema = xviewRangeQuerySchema.extend({ bucket: optionalString });
export type XViewSeriesQuery = z.infer<typeof xviewSeriesQuerySchema>;

export type XViewOutliersQuery = z.infer<typeof xviewRangeQuerySchema>;

const savedFilterListQuerySchema = z.object({ view: optionalString });
export type SavedFilterListQuery = z.infer<typeof savedFilterListQuerySchema>;

const sessionListQuerySchema = z.object({ days: optionalNumber });
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;

const waterfallQuerySchema = z.object({
  session_id: z.string(),
  limit: optionalNumber,
  slow_ms: optionalNumber,
});
export type WaterfallQuery = z.infer<typeof waterfallQuerySchema>;

const flowMapQuerySchema = z.object({ request_id: z.string() });
export type FlowMapQuery = z.infer<typeof flowMapQuerySchema>;

/** llmRequestScope() reads these on every /admin/llm/* endpoint. */
const llmScopeQuerySchema = z.object({
  window: optionalString,
  limit: optionalNumber,
  offset: optionalNumber,
  model: optionalString,
  api_key_id: optionalString,
  team: optionalString,
  session_id: optionalString,
  prompt_name: optionalString,
  prompt_version: optionalString,
  evaluation_name: optionalString,
  bucket: optionalString,
});
export type LLMScopeQuery = z.infer<typeof llmScopeQuerySchema>;

const llmSessionQuerySchema = z.object({ session_id: z.string(), limit: optionalNumber });
export type LLMSessionQuery = z.infer<typeof llmSessionQuerySchema>;

const llmPromptCompareQuerySchema = llmScopeQuerySchema.extend({
  prompt_name: z.string(),
  candidate: optionalString,
  baseline: optionalString,
  candidate_limit: optionalNumber,
});
export type LLMPromptCompareQuery = z.infer<typeof llmPromptCompareQuerySchema>;

const podsQuerySchema = z.object({ stale_s: optionalNumber });
export type PodsQuery = z.infer<typeof podsQuerySchema>;

export const observabilityEndpoints = {
  sessions: {
    list: operation<WithQuery<GetAdminSessionsData, SessionListQuery>, unknown>()(
      "GET",
      "/admin/sessions",
      sessionListResponseSchema,
      sessionListQuerySchema,
    ),
    flightRecorder: operation<GetAdminSessionsSessionIdFlightRecorderData, unknown>()(
      "GET",
      "/admin/sessions/{session_id}/flight-recorder",
      flightRecorderResponseSchema,
    ),
  },
  xview: {
    scatter: operation<WithQuery<GetAdminScatterData, ScatterQuery>, unknown>()(
      "GET",
      "/admin/scatter",
      scatterResponseSchema,
      scatterQuerySchema,
    ),
    delta: operation<WithQuery<GetAdminXviewDeltaData, XViewDeltaQuery>, unknown>()(
      "GET",
      "/admin/xview/delta",
      xviewDeltaResponseSchema,
      xviewDeltaQuerySchema,
    ),
    models: operation<WithQuery<GetAdminXviewModelsData, XViewModelsQuery>, unknown>()(
      "GET",
      "/admin/xview/models",
      xviewModelsResponseSchema,
      xviewModelsQuerySchema,
    ),
    modelSeries: operation<WithQuery<GetAdminXviewModelSeriesData, XViewSeriesQuery>, unknown>()(
      "GET",
      "/admin/xview/model-series",
      xviewModelSeriesResponseSchema,
      xviewSeriesQuerySchema,
    ),
    modelOutliers: operation<WithQuery<GetAdminXviewModelOutliersData, XViewOutliersQuery>, unknown>()(
      "GET",
      "/admin/xview/model-outliers",
      xviewModelOutliersResponseSchema,
      xviewRangeQuerySchema,
    ),
    waterfall: operation<WithQuery<GetAdminWaterfallData, WaterfallQuery>, unknown>()(
      "GET",
      "/admin/waterfall",
      waterfallResponseSchema,
      waterfallQuerySchema,
    ),
    flowMap: operation<WithQuery<GetAdminFlowMapData, FlowMapQuery>, unknown>()(
      "GET",
      "/admin/flow-map",
      flowMapResponseSchema,
      flowMapQuerySchema,
    ),
  },
  savedFilters: {
    list: operation<WithQuery<GetAdminSavedFiltersData, SavedFilterListQuery>, unknown>()(
      "GET",
      "/admin/saved-filters",
      savedFilterListSchema,
      savedFilterListQuerySchema,
    ),
    create: operation<WithBody<PostAdminSavedFiltersData, SavedFilterCreateBody>, unknown>()(
      "POST",
      "/admin/saved-filters",
      savedFilterEnvelopeSchema,
    ),
    update: operation<WithBody<PatchAdminSavedFiltersIdData, SavedFilterUpdateBody>, unknown>()(
      "PATCH",
      "/admin/saved-filters/{id}",
      savedFilterEnvelopeSchema,
    ),
    remove: operation<DeleteAdminSavedFiltersIdData, unknown>()(
      "DELETE",
      "/admin/saved-filters/{id}",
      savedFilterDeletedSchema,
    ),
  },
  llm: {
    traceDetail: operation<GetAdminLlmTracesIdData, unknown>()(
      "GET",
      "/admin/llm/traces/{id}",
      llmTraceDetailSchema,
    ),
    sessions: operation<WithQuery<GetAdminLlmSessionsData, LLMScopeQuery>, unknown>()(
      "GET",
      "/admin/llm/sessions",
      llmSessionsResponseSchema,
      llmScopeQuerySchema,
    ),
    sessionTimeline: operation<WithQuery<GetAdminLlmSessionData, LLMSessionQuery>, unknown>()(
      "GET",
      "/admin/llm/session",
      llmSessionTimelineSchema,
      llmSessionQuerySchema,
    ),
    evaluations: operation<WithQuery<GetAdminLlmEvaluationsData, LLMScopeQuery>, unknown>()(
      "GET",
      "/admin/llm/evaluations",
      llmEvaluationsResponseSchema,
      llmScopeQuerySchema,
    ),
    feedback: operation<WithQuery<GetAdminLlmFeedbackData, LLMScopeQuery>, unknown>()(
      "GET",
      "/admin/llm/feedback",
      llmFeedbackResponseSchema,
      llmScopeQuerySchema,
    ),
    submitFeedback: operation<WithBody<PostAdminLlmFeedbackData, LLMFeedbackBody>, unknown>()(
      "POST",
      "/admin/llm/feedback",
      llmFeedbackCreatedSchema,
    ),
    prompts: operation<WithQuery<GetAdminLlmPromptsData, LLMScopeQuery>, unknown>()(
      "GET",
      "/admin/llm/prompts",
      llmPromptsResponseSchema,
      llmScopeQuerySchema,
    ),
    promptCompare: operation<WithQuery<GetAdminLlmPromptsCompareData, LLMPromptCompareQuery>, unknown>()(
      "GET",
      "/admin/llm/prompts/compare",
      llmPromptCompareResponseSchema,
      llmPromptCompareQuerySchema,
    ),
    patterns: operation<WithQuery<GetAdminLlmPatternsData, LLMScopeQuery>, unknown>()(
      "GET",
      "/admin/llm/patterns",
      llmPatternsResponseSchema,
      llmScopeQuerySchema,
    ),
    insights: operation<WithQuery<GetAdminLlmInsightsData, LLMScopeQuery>, unknown>()(
      "GET",
      "/admin/llm/insights",
      llmInsightsResponseSchema,
      llmScopeQuerySchema,
    ),
    timeseries: operation<WithQuery<GetAdminLlmTimeseriesData, LLMScopeQuery>, unknown>()(
      "GET",
      "/admin/llm/timeseries",
      llmTimeseriesResponseSchema,
      llmScopeQuerySchema,
    ),
  },
  probes: {
    journey: operation<WithBody<PostAdminJourneyProbeData, JourneyProbeBody>, unknown>()(
      "POST",
      "/admin/journey-probe",
      journeyProbeResponseSchema,
    ),
    pods: operation<WithQuery<GetAdminPodsData, PodsQuery>, unknown>()(
      "GET",
      "/admin/pods",
      podsResponseSchema,
      podsQuerySchema,
    ),
  },
  requests: {
    explain: operation<GetAdminRequestsIdExplainData, unknown>()(
      "GET",
      "/admin/requests/{id}/explain",
      requestExplainSchema,
    ),
    note: operation<GetAdminRequestsIdNoteData, unknown>()(
      "GET",
      "/admin/requests/{id}/note",
      requestNoteSchema,
    ),
    // POST and PUT share one upsert handler; PUT states the intent the screen has.
    saveNote: operation<WithBody<PutAdminRequestsIdNoteData, RequestNoteBody>, unknown>()(
      "PUT",
      "/admin/requests/{id}/note",
      requestNoteSchema,
    ),
    removeNote: operation<DeleteAdminRequestsIdNoteData, unknown>()(
      "DELETE",
      "/admin/requests/{id}/note",
      requestNoteDeletedSchema,
    ),
    /** Sends the request's prompts to a model, so it needs raw-prompt access. */
    analyze: operation<PostAdminRequestsIdAnalyzeData, unknown>()(
      "POST",
      "/admin/requests/{id}/analyze",
      requestAnalysisSchema,
    ),
    /** Re-sends the stored raw body upstream — a real, billable call. */
    replay: operation<PostAdminRequestsIdReplayData, unknown>()(
      "POST",
      "/admin/requests/{id}/replay",
      requestReplaySchema,
    ),
  },
  capabilities: operation<GetAdminCapabilitiesData, unknown>()(
    "GET",
    "/admin/capabilities",
    capabilitiesResponseSchema,
  ),
} as const;

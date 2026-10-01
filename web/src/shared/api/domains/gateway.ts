import { z } from "zod";

import type {
  DeleteAdminModelDeprecationsIdData,
  DeleteAdminModelDeprecationsIdResponse,
  DeleteAdminModelTagsIdData,
  DeleteAdminModelTagsIdResponse,
  DeleteAdminModelsContractsData,
  DeleteAdminModelsContractsResponse,
  DeleteAdminPromptLabExperimentsIdData,
  DeleteAdminPromptLabTestCasesIdData,
  DeleteAdminProvidersNameData,
  DeleteAdminProvidersSloData,
  GetAdminChatTestMultiRunLeaderboardData,
  GetAdminChatTestMultiRunRunsData,
  GetAdminChatTestMultiRunRunsIdCodeVerifyData,
  GetAdminChatTestMultiRunRunsIdDiffData,
  GetAdminChatTestMultiRunRunsIdExportData,
  GetAdminChatTestTargetsData,
  GetAdminCodeVerifyStatsData,
  GetAdminModelDeprecationsData,
  GetAdminModelDeprecationsResponse,
  GetAdminModelsContractsData,
  GetAdminModelsContractsResponse,
  GetAdminPromptLabContractsData,
  GetAdminPromptLabExperimentsData,
  GetAdminPromptLabExperimentsIdData,
  GetAdminPromptLabRubricsData,
  GetAdminPromptLabTestCasesIdData,
  GetAdminRoutingBalancerData,
  PatchAdminPromptLabExperimentsIdData,
  PostAdminChatTestMultiRunData,
  PostAdminChatTestMultiRunJudgeData,
  PostAdminChatTestMultiRunPredictData,
  PostAdminChatTestMultiRunRunsIdFeedbackData,
  PostAdminChatTestMultiRunRunsIdGoldenData,
  PostAdminChatTestMultiRunRunsIdPromoteData,
  PostAdminChatTestRunData,
  PostAdminChatTestStreamData,
  PostAdminCodeVerifyData,
  PostAdminModelDeprecationsData,
  PostAdminModelDeprecationsResponse,
  PostAdminModelTagsData,
  PostAdminModelTagsResponse,
  PostAdminModelsContractsData,
  PostAdminModelsContractsResponse,
  PostAdminModelsContractsRunData,
  PostAdminModelsContractsRunResponse,
  PostAdminPromptLabContractsData,
  PostAdminPromptLabExperimentsData,
  PostAdminPromptLabRubricsData,
  PostAdminPromptLabTestCasesData,
  PostAdminPromptLabTestCasesIdRunData,
  PostAdminProvidersData,
  PostAdminProviderConnectionTestData,
  PostAdminProviderConnectionTestResponse,
  PostAdminProvidersSloData,
  PostAdminRoutingBalancerData,
  PostAdminRoutingBreakerResetData,
  PostAdminRoutingPreviewData,
} from "@/shared/api/generated";
import { operation, route, type WithBody, type WithQuery } from "@/shared/api/endpoint-factory";
import { providerConnectionSchema, type ProviderConnectionBody } from "./provider-connection.schemas";
import {
  balancerReleaseSchema,
  balancerSchema,
  breakerResetSchema,
  chatTestTargetsSchema,
  codeVerifyReportSchema,
  codeVerifyStatsSchema,
  gatewayAcknowledgementSchema,
  modelContractListSchema,
  modelContractDeleteSchema,
  modelContractRunSchema,
  modelContractSaveSchema,
  modelDeprecationDeleteSchema,
  modelDeprecationListSchema,
  modelDeprecationSaveSchema,
  modelUsageTagWriteSchema,
  modelUsageTagDeleteSchema,
  multiRunCodeVerifySchema,
  multiRunDiffSchema,
  multiRunFeedbackSchema,
  multiRunGoldenSchema,
  multiRunJudgeSchema,
  multiRunLeaderboardSchema,
  multiRunListSchema,
  multiRunPredictSchema,
  multiRunPromoteSchema,
  multiRunResponseSchema,
  promptContractListSchema,
  promptContractSchema,
  promptExperimentDetailSchema,
  promptExperimentListSchema,
  promptExperimentSchema,
  promptExperimentStatusSchema,
  promptRubricListSchema,
  promptRubricSchema,
  promptTestCaseDetailSchema,
  promptTestCaseRunSchema,
  promptTestCaseSchema,
  providerDeleteSchema,
  providerSLODeleteSchema,
  providerSLOSaveSchema,
  providerSaveSchema,
  routingPreviewSchema,
} from "@/shared/api/domains/gateway.schemas";

// Bodies for still-untyped legacy operations mirror the Go decode structs below.
// Model governance instead uses the explicit generated OpenAPI body/response
// contracts, retaining their existing optional/null replacement semantics.

export interface ChatTestRunBody {
  readonly target_id?: string;
  readonly model: string;
  readonly provider?: string;
  readonly prompt?: string;
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly api_key_id?: string;
  readonly bearer_token?: string;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly no_route?: boolean;
  readonly include_preview?: boolean;
}

export interface MultiRunBody {
  readonly title?: string;
  readonly models: ReadonlyArray<{ readonly model: string; readonly provider?: string }>;
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly prompt?: string;
  readonly params?: {
    readonly temperature?: number;
    readonly max_tokens?: number;
    readonly timeout_ms?: number;
  };
  readonly save_prompt?: boolean;
}

export interface MultiRunJudgeBody {
  readonly run_id: string;
  readonly method: "rule" | "model";
  readonly judge_model?: string;
  readonly rubric?: string;
}

export interface MultiRunFeedbackBody {
  readonly model: string;
  /** 0–5; the server rejects anything outside that range. */
  readonly rating: number;
  readonly label?: string;
  readonly comment?: string;
}

export interface MultiRunPromoteBody {
  readonly model: string;
  readonly task_type?: string;
  readonly reason?: string;
}

export interface MultiRunGoldenBody {
  readonly selected_model: string;
  readonly workflow_id?: string;
  readonly workflow_name?: string;
  readonly step_name?: string;
  readonly task_type?: string;
  readonly contract_id?: string;
  readonly rubric_id?: string;
  /** Sent only when the run itself stored no prompt; never persisted by the console. */
  readonly prompt?: string;
  readonly expected?: string;
}

export interface ProviderWriteBody {
  readonly name: string;
  readonly base_url: string;
  /** Write-only: never rendered or stored client side. */
  readonly api_key?: string;
  readonly timeout_ms?: number;
  readonly enabled?: boolean;
  readonly model_patterns?: string;
  readonly failover_group?: string;
  readonly priority?: number;
}

export interface ProviderSLOWriteBody {
  readonly provider: string;
  readonly availability_target: number;
  readonly p95_latency_target_ms: number;
  readonly error_rate_target: number;
  readonly fallback_rate_target: number;
  readonly enabled: boolean;
  readonly note?: string;
}

export type ModelContractWriteBody = Readonly<PostAdminModelsContractsData["body"]>;
export type ModelDeprecationWriteBody = Readonly<PostAdminModelDeprecationsData["body"]>;

export type ModelUsageTagWriteBody = Readonly<PostAdminModelTagsData["body"]>;

export interface PromptExperimentWriteBody {
  readonly title: string;
  readonly description?: string;
  readonly team?: string;
}

export interface PromptContractWriteBody {
  readonly name: string;
  readonly type: string;
  readonly schema_json?: string;
  readonly strict?: boolean;
}

export interface PromptRubricWriteBody {
  readonly name: string;
  readonly criteria?: unknown;
}

export interface PromptExperimentPatchBody {
  readonly status: "active" | "archived";
}

export interface PromptTestCaseRunBody {
  /** Overrides the models saved on the test case; empty means "use the saved ones". */
  readonly models?: readonly string[];
  readonly save_prompt?: boolean;
}

export interface PromptTestCaseWriteBody {
  readonly experiment_id: string;
  readonly name: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly rubric_id?: string;
  readonly contract_id?: string;
  readonly models?: readonly string[];
}

const providerNameQuerySchema = z.object({ provider: z.string().min(1) }).strict();
const contractIdQuerySchema = z.object({ id: z.string().min(1) }).strict();
const leaderboardQuerySchema = z
  .object({ days: z.number().int().positive().max(365).optional(), team: z.string().optional() })
  .strict();
const runsQuerySchema = z.object({ limit: z.number().int().positive().max(200).optional() }).strict();
const codeVerifyStatsQuerySchema = z
  .object({ days: z.number().int().positive().max(365).optional() })
  .strict();
const contractListQuerySchema = z.object({ enabled: z.literal("1").optional() }).strict();
const balancerQuerySchema = z
  .object({ window: z.string().optional(), model: z.string().optional() })
  .strict();

export const gatewayEndpoints = {
  chat: {
    targets: operation<GetAdminChatTestTargetsData, unknown>()(
      "GET",
      "/admin/chat-test/targets",
      chatTestTargetsSchema,
    ),
    run: operation<WithBody<PostAdminChatTestRunData, ChatTestRunBody>, unknown>()(
      "POST",
      "/admin/chat-test/run",
      z.unknown(),
    ),
    // SSE: read with `fetch` + ReadableStream so the console can stream and cancel.
    stream: route<PostAdminChatTestStreamData>()("POST", "/admin/chat-test/stream"),
    routingPreview: operation<WithBody<PostAdminRoutingPreviewData, unknown>, unknown>()(
      "POST",
      "/admin/routing/preview",
      routingPreviewSchema,
    ),
    codeVerify: operation<WithBody<PostAdminCodeVerifyData, { readonly text: string }>, unknown>()(
      "POST",
      "/admin/code-verify",
      codeVerifyReportSchema,
    ),
    codeVerifyStats: operation<WithQuery<GetAdminCodeVerifyStatsData, { days?: number }>, unknown>()(
      "GET",
      "/admin/code-verify/stats",
      codeVerifyStatsSchema,
      codeVerifyStatsQuerySchema,
    ),
    multiRun: operation<WithBody<PostAdminChatTestMultiRunData, MultiRunBody>, unknown>()(
      "POST",
      "/admin/chat-test/multi-run",
      multiRunResponseSchema,
    ),
    multiRunPredict: operation<WithBody<PostAdminChatTestMultiRunPredictData, MultiRunBody>, unknown>()(
      "POST",
      "/admin/chat-test/multi-run/predict",
      multiRunPredictSchema,
    ),
    multiRuns: operation<WithQuery<GetAdminChatTestMultiRunRunsData, { limit?: number }>, unknown>()(
      "GET",
      "/admin/chat-test/multi-run/runs",
      multiRunListSchema,
      runsQuerySchema,
    ),
    multiRunCodeVerify: operation<GetAdminChatTestMultiRunRunsIdCodeVerifyData, unknown>()(
      "GET",
      "/admin/chat-test/multi-run/runs/{id}/code-verify",
      multiRunCodeVerifySchema,
    ),
    multiRunJudge: operation<WithBody<PostAdminChatTestMultiRunJudgeData, MultiRunJudgeBody>, unknown>()(
      "POST",
      "/admin/chat-test/multi-run/judge",
      multiRunJudgeSchema,
    ),
    multiRunFeedback: operation<
      WithBody<PostAdminChatTestMultiRunRunsIdFeedbackData, MultiRunFeedbackBody>,
      unknown
    >()("POST", "/admin/chat-test/multi-run/runs/{id}/feedback", multiRunFeedbackSchema),
    multiRunPromote: operation<
      WithBody<PostAdminChatTestMultiRunRunsIdPromoteData, MultiRunPromoteBody>,
      unknown
    >()("POST", "/admin/chat-test/multi-run/runs/{id}/promote", multiRunPromoteSchema),
    multiRunGolden: operation<
      WithBody<PostAdminChatTestMultiRunRunsIdGoldenData, MultiRunGoldenBody>,
      unknown
    >()("POST", "/admin/chat-test/multi-run/runs/{id}/golden", multiRunGoldenSchema),
    multiRunDiff: operation<GetAdminChatTestMultiRunRunsIdDiffData, unknown>()(
      "GET",
      "/admin/chat-test/multi-run/runs/{id}/diff",
      multiRunDiffSchema,
    ),
    // File response (markdown / csv / json): downloaded with `fetch`, not `apiClient`.
    multiRunExport: route<GetAdminChatTestMultiRunRunsIdExportData>()(
      "GET",
      "/admin/chat-test/multi-run/runs/{id}/export",
    ),
    leaderboard: operation<
      WithQuery<GetAdminChatTestMultiRunLeaderboardData, { days?: number; team?: string }>,
      unknown
    >()("GET", "/admin/chat-test/multi-run/leaderboard", multiRunLeaderboardSchema, leaderboardQuerySchema),
  },
  providers: {
    connectionTest: operation<
      WithBody<PostAdminProviderConnectionTestData, ProviderConnectionBody>,
      PostAdminProviderConnectionTestResponse
    >()("POST", "/admin/provider-connection-test", providerConnectionSchema),
    save: operation<WithBody<PostAdminProvidersData, ProviderWriteBody>, unknown>()(
      "POST",
      "/admin/providers",
      providerSaveSchema,
    ),
    remove: operation<DeleteAdminProvidersNameData, unknown>()(
      "DELETE",
      "/admin/providers/{name}",
      providerDeleteSchema,
    ),
    saveSlo: operation<WithBody<PostAdminProvidersSloData, ProviderSLOWriteBody>, unknown>()(
      "POST",
      "/admin/providers/slo",
      providerSLOSaveSchema,
    ),
    removeSlo: operation<DeleteAdminProvidersSloData, unknown>()(
      "DELETE",
      "/admin/providers/slo",
      providerSLODeleteSchema,
      providerNameQuerySchema,
    ),
  },
  models: {
    contracts: {
      list: operation<
        WithQuery<GetAdminModelsContractsData, { enabled?: "1" }>,
        GetAdminModelsContractsResponse
      >()("GET", "/admin/models/contracts", modelContractListSchema, contractListQuerySchema),
      save: operation<PostAdminModelsContractsData, PostAdminModelsContractsResponse>()(
        "POST",
        "/admin/models/contracts",
        modelContractSaveSchema,
      ),
      remove: operation<DeleteAdminModelsContractsData, DeleteAdminModelsContractsResponse>()(
        "DELETE",
        "/admin/models/contracts",
        modelContractDeleteSchema,
        contractIdQuerySchema,
      ),
      run: operation<PostAdminModelsContractsRunData, PostAdminModelsContractsRunResponse>()(
        "POST",
        "/admin/models/contracts/run",
        modelContractRunSchema,
      ),
    },
    deprecations: {
      list: operation<GetAdminModelDeprecationsData, GetAdminModelDeprecationsResponse>()(
        "GET",
        "/admin/model-deprecations",
        modelDeprecationListSchema,
      ),
      save: operation<PostAdminModelDeprecationsData, PostAdminModelDeprecationsResponse>()(
        "POST",
        "/admin/model-deprecations",
        modelDeprecationSaveSchema,
      ),
      remove: operation<DeleteAdminModelDeprecationsIdData, DeleteAdminModelDeprecationsIdResponse>()(
        "DELETE",
        "/admin/model-deprecations/{id}",
        modelDeprecationDeleteSchema,
      ),
    },
    tags: {
      save: operation<PostAdminModelTagsData, PostAdminModelTagsResponse>()(
        "POST",
        "/admin/model-tags",
        modelUsageTagWriteSchema,
      ),
      remove: operation<DeleteAdminModelTagsIdData, DeleteAdminModelTagsIdResponse>()(
        "DELETE",
        "/admin/model-tags/{id}",
        modelUsageTagDeleteSchema,
      ),
    },
  },
  routing: {
    breakerReset: operation<
      WithBody<PostAdminRoutingBreakerResetData, { readonly provider: string }>,
      unknown
    >()("POST", "/admin/routing/breaker-reset", breakerResetSchema),
    balancer: operation<
      WithQuery<GetAdminRoutingBalancerData, { window?: string; model?: string }>,
      unknown
    >()("GET", "/admin/routing/balancer", balancerSchema, balancerQuerySchema),
    releaseSessions: operation<
      WithBody<PostAdminRoutingBalancerData, { readonly provider: string }>,
      unknown
    >()("POST", "/admin/routing/balancer", balancerReleaseSchema),
  },
  promptLab: {
    experiments: {
      list: operation<GetAdminPromptLabExperimentsData, unknown>()(
        "GET",
        "/admin/prompt-lab/experiments",
        promptExperimentListSchema,
      ),
      create: operation<WithBody<PostAdminPromptLabExperimentsData, PromptExperimentWriteBody>, unknown>()(
        "POST",
        "/admin/prompt-lab/experiments",
        promptExperimentSchema,
      ),
      detail: operation<GetAdminPromptLabExperimentsIdData, unknown>()(
        "GET",
        "/admin/prompt-lab/experiments/{id}",
        promptExperimentDetailSchema,
      ),
      updateStatus: operation<
        WithBody<PatchAdminPromptLabExperimentsIdData, PromptExperimentPatchBody>,
        unknown
      >()("PATCH", "/admin/prompt-lab/experiments/{id}", promptExperimentStatusSchema),
      remove: operation<DeleteAdminPromptLabExperimentsIdData, unknown>()(
        "DELETE",
        "/admin/prompt-lab/experiments/{id}",
        gatewayAcknowledgementSchema,
      ),
    },
    contracts: {
      list: operation<GetAdminPromptLabContractsData, unknown>()(
        "GET",
        "/admin/prompt-lab/contracts",
        promptContractListSchema,
      ),
      create: operation<WithBody<PostAdminPromptLabContractsData, PromptContractWriteBody>, unknown>()(
        "POST",
        "/admin/prompt-lab/contracts",
        promptContractSchema,
      ),
    },
    rubrics: {
      list: operation<GetAdminPromptLabRubricsData, unknown>()(
        "GET",
        "/admin/prompt-lab/rubrics",
        promptRubricListSchema,
      ),
      create: operation<WithBody<PostAdminPromptLabRubricsData, PromptRubricWriteBody>, unknown>()(
        "POST",
        "/admin/prompt-lab/rubrics",
        promptRubricSchema,
      ),
    },
    testCases: {
      create: operation<WithBody<PostAdminPromptLabTestCasesData, PromptTestCaseWriteBody>, unknown>()(
        "POST",
        "/admin/prompt-lab/test-cases",
        promptTestCaseSchema,
      ),
      detail: operation<GetAdminPromptLabTestCasesIdData, unknown>()(
        "GET",
        "/admin/prompt-lab/test-cases/{id}",
        promptTestCaseDetailSchema,
      ),
      remove: operation<DeleteAdminPromptLabTestCasesIdData, unknown>()(
        "DELETE",
        "/admin/prompt-lab/test-cases/{id}",
        gatewayAcknowledgementSchema,
      ),
      run: operation<WithBody<PostAdminPromptLabTestCasesIdRunData, PromptTestCaseRunBody>, unknown>()(
        "POST",
        "/admin/prompt-lab/test-cases/{id}/run",
        promptTestCaseRunSchema,
      ),
    },
  },
} as const;

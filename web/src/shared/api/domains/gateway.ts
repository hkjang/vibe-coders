import { z } from "zod";

import type {
  DeleteAdminModelDeprecationsIdData,
  DeleteAdminModelTagsIdData,
  DeleteAdminModelsContractsData,
  DeleteAdminPromptLabTestCasesIdData,
  DeleteAdminProvidersNameData,
  DeleteAdminProvidersSloData,
  GetAdminChatTestMultiRunLeaderboardData,
  GetAdminChatTestMultiRunRunsData,
  GetAdminChatTestMultiRunRunsIdCodeVerifyData,
  GetAdminChatTestMultiRunRunsIdData,
  GetAdminChatTestTargetsData,
  GetAdminCodeVerifyStatsData,
  GetAdminModelDeprecationsData,
  GetAdminModelsContractsData,
  GetAdminPromptLabContractsData,
  GetAdminPromptLabExperimentsData,
  GetAdminPromptLabExperimentsIdData,
  GetAdminPromptLabRubricsData,
  GetAdminPromptLabTestCasesIdData,
  GetAdminRoutingBalancerData,
  PostAdminChatTestMultiRunData,
  PostAdminChatTestMultiRunJudgeData,
  PostAdminChatTestMultiRunPredictData,
  PostAdminChatTestRunData,
  PostAdminChatTestStreamData,
  PostAdminCodeVerifyData,
  PostAdminMcpRouteExplainData,
  PostAdminMcpTestData,
  PostAdminModelDeprecationsData,
  PostAdminModelTagsData,
  PostAdminModelsContractsData,
  PostAdminModelsContractsRunData,
  PostAdminPromptLabContractsData,
  PostAdminPromptLabExperimentsData,
  PostAdminPromptLabRubricsData,
  PostAdminPromptLabTestCasesData,
  PostAdminProvidersData,
  PostAdminProvidersSloData,
  PostAdminRoutingBalancerData,
  PostAdminRoutingBreakerResetData,
  PostAdminRoutingPreviewData,
} from "@/shared/api/generated";
import type { OpenApiPath } from "@/shared/api/generated/paths.gen";
import {
  operation,
  pathWithParams,
  route,
  type OperationData,
  type WithQuery,
} from "@/shared/api/endpoint-factory";
import {
  balancerReleaseSchema,
  balancerSchema,
  breakerResetSchema,
  chatTestTargetsSchema,
  codeVerifyReportSchema,
  codeVerifyStatsSchema,
  gatewayAcknowledgementSchema,
  mcpRouteExplainSchema,
  mcpTestSchema,
  modelContractListSchema,
  modelContractRunSchema,
  modelDeprecationListSchema,
  modelDeprecationSaveSchema,
  modelUsageTagWriteSchema,
  multiRunCodeVerifySchema,
  multiRunDetailSchema,
  multiRunJudgeSchema,
  multiRunLeaderboardSchema,
  multiRunListSchema,
  multiRunPredictSchema,
  multiRunResponseSchema,
  promptContractListSchema,
  promptContractSchema,
  promptExperimentDetailSchema,
  promptExperimentListSchema,
  promptExperimentSchema,
  promptRubricListSchema,
  promptRubricSchema,
  promptTestCaseDetailSchema,
  promptTestCaseSchema,
  providerDeleteSchema,
  providerSLODeleteSchema,
  providerSLOSaveSchema,
  providerSaveSchema,
  routingPreviewSchema,
} from "@/shared/api/domains/gateway.schemas";

/**
 * Adds a request body to a generated operation. The legacy admin API is documented
 * without request schemas, so the generated `Data` types carry `body?: never`; the
 * shapes below mirror the Go handlers' decode structs.
 */
type WithBody<Data extends OperationData, Body> = Omit<Data, "body"> & { readonly body: Body };

/** Fills `{id}` / `{name}` in a declared path so the client calls the concrete resource. */
export function withGatewayPathParams<Endpoint extends { readonly path: OpenApiPath }>(
  endpoint: Endpoint,
  params: Readonly<Record<string, string | number>>,
): Endpoint {
  return { ...endpoint, path: pathWithParams(endpoint.path, params) };
}

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

export interface ModelContractWriteBody {
  readonly id?: string;
  readonly name: string;
  readonly task_type?: string;
  readonly min_quality_score?: number;
  readonly min_golden_pass_rate?: number;
  readonly min_success_rate?: number;
  readonly max_latency_ms?: number;
  readonly max_avg_cost_krw?: number;
  readonly enabled?: boolean;
}

export interface ModelDeprecationWriteBody {
  readonly model_glob: string;
  readonly replacement?: string;
  readonly sunset_date?: string;
  readonly message?: string;
}

export interface ModelUsageTagWriteBody {
  readonly model: string;
  readonly good_for?: string;
  readonly avoid_for?: string;
  readonly risk_note?: string;
}

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
    mcpRouteExplain: operation<WithBody<PostAdminMcpRouteExplainData, unknown>, unknown>()(
      "POST",
      "/admin/mcp/route/explain",
      mcpRouteExplainSchema,
    ),
    mcpTest: operation<WithBody<PostAdminMcpTestData, unknown>, unknown>()(
      "POST",
      "/admin/mcp/test",
      mcpTestSchema,
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
    multiRunDetail: operation<GetAdminChatTestMultiRunRunsIdData, unknown>()(
      "GET",
      "/admin/chat-test/multi-run/runs/{id}",
      multiRunDetailSchema,
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
    leaderboard: operation<
      WithQuery<GetAdminChatTestMultiRunLeaderboardData, { days?: number; team?: string }>,
      unknown
    >()("GET", "/admin/chat-test/multi-run/leaderboard", multiRunLeaderboardSchema, leaderboardQuerySchema),
  },
  providers: {
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
      list: operation<WithQuery<GetAdminModelsContractsData, { enabled?: "1" }>, unknown>()(
        "GET",
        "/admin/models/contracts",
        modelContractListSchema,
        contractListQuerySchema,
      ),
      save: operation<WithBody<PostAdminModelsContractsData, ModelContractWriteBody>, unknown>()(
        "POST",
        "/admin/models/contracts",
        gatewayAcknowledgementSchema,
      ),
      remove: operation<WithQuery<DeleteAdminModelsContractsData, { id: string }>, unknown>()(
        "DELETE",
        "/admin/models/contracts",
        gatewayAcknowledgementSchema,
        contractIdQuerySchema,
      ),
      run: operation<
        WithBody<
          PostAdminModelsContractsRunData,
          { readonly model: string; readonly contract_id?: string; readonly window?: string }
        >,
        unknown
      >()("POST", "/admin/models/contracts/run", modelContractRunSchema),
    },
    deprecations: {
      list: operation<GetAdminModelDeprecationsData, unknown>()(
        "GET",
        "/admin/model-deprecations",
        modelDeprecationListSchema,
      ),
      save: operation<WithBody<PostAdminModelDeprecationsData, ModelDeprecationWriteBody>, unknown>()(
        "POST",
        "/admin/model-deprecations",
        modelDeprecationSaveSchema,
      ),
      remove: operation<DeleteAdminModelDeprecationsIdData, unknown>()(
        "DELETE",
        "/admin/model-deprecations/{id}",
        gatewayAcknowledgementSchema,
      ),
    },
    tags: {
      save: operation<WithBody<PostAdminModelTagsData, ModelUsageTagWriteBody>, unknown>()(
        "POST",
        "/admin/model-tags",
        modelUsageTagWriteSchema,
      ),
      remove: operation<DeleteAdminModelTagsIdData, unknown>()(
        "DELETE",
        "/admin/model-tags/{id}",
        gatewayAcknowledgementSchema,
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
    },
  },
} as const;

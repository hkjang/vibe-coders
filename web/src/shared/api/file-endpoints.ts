import { z } from "zod";

import { fileOperation, type WithQuery } from "@/shared/api/endpoint-factory";
import type {
  GetAdminCostChargebackPackData,
  GetAdminChatTestMultiRunRunsIdExportData,
  GetAdminRedteamProbePacksExportData,
  GetAdminPoliciesExportData,
  GetAdminTeamsScorecardData,
  GetAdminReportsNarrativeData,
  GetAdminSbomData,
  GetAdminPrivacyLedgerData,
  GetAdminDwDashboardExportCsvData,
  GetAdminWorkIntelExportCsvData,
} from "@/shared/api/generated";
import { workExportQuerySchema, type WorkExportQuery } from "@/shared/api/domains/insights-usage";
import { policyImportLimits } from "@/shared/api/domains/policy-import-json";

const chargebackQuery = z
  .object({
    format: z.literal("csv"),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
  })
  .strict();

const reportWindow = z.enum(["7d", "30d", "90d"]);
const scorecardQuery = z.object({ window: reportWindow, format: z.literal("csv") }).strict();
const narrativeQuery = z.object({ window: reportWindow, format: z.literal("md") }).strict();
const privacyQuery = z
  .object({
    dimension: z.enum(["team", "model", "provider"]),
    days: z.number().int().min(1).max(365),
    format: z.literal("csv"),
  })
  .strict();
const warehouseQuery = z
  .object({
    since_day: z.string().optional(),
    until_day: z.string().optional(),
    window: z.enum(["7d", "30d", "90d"]),
    dimension: z.enum(["model", "provider", "project", "cost_center"]),
    order_by: z.enum(["cost", "requests", "tokens", "errors"]),
    limit: z.literal(100),
  })
  .strict();

const multiRunCsvQuery = z.object({ format: z.literal("csv") }).strict();
const multiRunMarkdownQuery = z.object({ format: z.literal("md") }).strict();
const multiRunJsonQuery = z.object({ format: z.literal("json") }).strict();

const probeCsvQuery = z.object({ format: z.literal("csv") }).strict();

export const fileEndpoints = {
  probeCsv: fileOperation<WithQuery<GetAdminRedteamProbePacksExportData, z.infer<typeof probeCsvQuery>>>()(
    "GET",
    "/admin/redteam/probe-packs/export",
    { contentTypes: ["text/csv"] },
    probeCsvQuery,
  ),
  multiRunCsv: fileOperation<
    WithQuery<GetAdminChatTestMultiRunRunsIdExportData, z.infer<typeof multiRunCsvQuery>>
  >()("GET", "/admin/chat-test/multi-run/runs/{id}/export", { contentTypes: ["text/csv"] }, multiRunCsvQuery),
  multiRunMarkdown: fileOperation<
    WithQuery<GetAdminChatTestMultiRunRunsIdExportData, z.infer<typeof multiRunMarkdownQuery>>
  >()(
    "GET",
    "/admin/chat-test/multi-run/runs/{id}/export",
    { contentTypes: ["text/markdown"] },
    multiRunMarkdownQuery,
  ),
  multiRunJson: fileOperation<
    WithQuery<GetAdminChatTestMultiRunRunsIdExportData, z.infer<typeof multiRunJsonQuery>>
  >()(
    "GET",
    "/admin/chat-test/multi-run/runs/{id}/export",
    { contentTypes: ["application/json"] },
    multiRunJsonQuery,
  ),
  scorecard: fileOperation<WithQuery<GetAdminTeamsScorecardData, z.infer<typeof scorecardQuery>>>()(
    "GET",
    "/admin/teams/scorecard",
    { contentTypes: ["text/csv"] },
    scorecardQuery,
  ),
  narrative: fileOperation<WithQuery<GetAdminReportsNarrativeData, z.infer<typeof narrativeQuery>>>()(
    "GET",
    "/admin/reports/narrative",
    { contentTypes: ["text/markdown"] },
    narrativeQuery,
  ),
  sbom: fileOperation<GetAdminSbomData>()("GET", "/admin/sbom", { contentTypes: ["application/json"] }),
  privacyLedger: fileOperation<WithQuery<GetAdminPrivacyLedgerData, z.infer<typeof privacyQuery>>>()(
    "GET",
    "/admin/privacy-ledger",
    { contentTypes: ["text/csv"] },
    privacyQuery,
  ),
  warehouse: fileOperation<GetAdminDwDashboardExportCsvData>()(
    "GET",
    "/admin/dw/dashboard/export.csv",
    { contentTypes: ["text/csv"] },
    warehouseQuery,
  ),
  workUsage: fileOperation<WithQuery<GetAdminWorkIntelExportCsvData, WorkExportQuery>>()(
    "GET",
    "/admin/work-intel/export.csv",
    { contentTypes: ["text/csv"] },
    workExportQuerySchema,
  ),
  chargeback: fileOperation<WithQuery<GetAdminCostChargebackPackData, z.infer<typeof chargebackQuery>>>()(
    "GET",
    "/admin/cost/chargeback-pack",
    { contentTypes: ["text/csv"] },
    chargebackQuery,
  ),
  policyBackup: fileOperation<GetAdminPoliciesExportData>()("GET", "/admin/policies/export", {
    contentTypes: ["application/json"],
    maxBytes: policyImportLimits.bytes,
    tooLargeMessage:
      "내보내기 응답이 UI 한도 4 MiB를 초과했습니다. 잘라 내려받지 않습니다. 정식 운영 백업 절차를 이용하세요.",
  }),
} as const;

export type RegisteredFileEndpoint = (typeof fileEndpoints)[keyof typeof fileEndpoints];

import { z } from "zod";

import { fileOperation, type WithQuery } from "@/shared/api/endpoint-factory";
import type { GetAdminCostChargebackPackData, GetAdminPoliciesExportData } from "@/shared/api/generated";
import { policyImportLimits } from "@/shared/api/domains/policy-import-json";

const chargebackQuery = z
  .object({
    format: z.literal("csv"),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
  })
  .strict();

export const fileEndpoints = {
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

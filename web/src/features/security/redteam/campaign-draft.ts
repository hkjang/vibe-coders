import { z } from "zod";

import type { RedTeamCampaign } from "@/shared/api/domains/redteam";

const numberField = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0), {
      message: `${label}은(는) 0 이상의 숫자여야 합니다.`,
    })
    .transform((value) => (value === "" ? 0 : Number(value)));

export const campaignFormSchema = z.object({
  name: z.string().trim().min(1, "캠페인 이름을 입력하세요."),
  scope: z.string(),
  execution_mode: z.string(),
  provider: z.string(),
  models: z.array(z.string()),
  budget_limit_krw: numberField("예산 한도"),
  qps_limit: numberField("QPS 한도"),
  destructive_tool_policy: z.string(),
  retain_raw_evidence: z.boolean(),
  probe_pack_ids: z.array(z.string()).min(1, "프로브 팩을 1개 이상 선택하세요."),
});

export type CampaignFormInput = z.input<typeof campaignFormSchema>;
export type CampaignFormValues = z.output<typeof campaignFormSchema>;

export interface CampaignDraft {
  /** Set when editing an existing campaign; empty for create and clone. */
  readonly id: string;
  readonly values: CampaignFormInput;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" && value !== "" ? [value] : [];
}

/** Turns a stored campaign into form values; `clone` drops the id and marks the name. */
export function campaignToDraft(
  campaign: RedTeamCampaign,
  mode: "edit" | "clone",
  allPackIds: readonly string[],
): CampaignDraft {
  const filter = campaign.target_filter;
  return {
    id: mode === "edit" ? campaign.id : "",
    values: {
      name: mode === "edit" ? campaign.name : `${campaign.name} (복제)`,
      scope: campaign.scope || "all",
      execution_mode: campaign.execution_mode || "dry-run",
      provider: typeof filter.provider === "string" ? filter.provider : "",
      models: stringList(filter.models ?? filter.model),
      budget_limit_krw: String(campaign.budget_limit_krw),
      qps_limit: String(campaign.qps_limit),
      destructive_tool_policy: campaign.destructive_tool_policy || "dry-run",
      retain_raw_evidence: campaign.retain_raw_evidence,
      probe_pack_ids: campaign.probe_pack_ids.length > 0 ? [...campaign.probe_pack_ids] : [...allPackIds],
    },
  };
}

export function emptyDraft(allPackIds: readonly string[]): CampaignDraft {
  return {
    id: "",
    values: {
      name: "",
      scope: "all",
      execution_mode: "dry-run",
      provider: "",
      models: [],
      budget_limit_krw: "1000",
      qps_limit: "1",
      destructive_tool_policy: "dry-run",
      retain_raw_evidence: false,
      probe_pack_ids: [...allPackIds],
    },
  };
}

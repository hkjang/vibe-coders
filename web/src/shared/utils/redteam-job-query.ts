import { validRunRef } from "./redteam-run-query";

export interface RedTeamJobRef {
  id: string;
  campaign: string;
}
export const redTeamJobKey = (ref: RedTeamJobRef) =>
  ["redteam", "execution-job", ref.campaign, ref.id] as const;
export const validRedTeamJobId = (value: string): boolean => /^rtj_[a-f0-9]{64}$/u.test(value);
export function readRedTeamJobRef(
  params: URLSearchParams,
  prefixes: readonly string[] = [],
): RedTeamJobRef | undefined {
  const ids = params.getAll("execution_job");
  const campaigns = params.getAll("job_campaign");
  const id = ids[0] ?? "";
  const campaign = campaigns[0] ?? "";
  return ids.length === 1 &&
    campaigns.length === 1 &&
    validRedTeamJobId(id) &&
    campaign !== "" &&
    validRunRef(campaign, prefixes)
    ? { id, campaign }
    : undefined;
}

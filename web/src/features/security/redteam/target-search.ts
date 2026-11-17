import type { RedTeamTarget } from "@/shared/api/domains/redteam";
import { riskLabel, targetTypeLabel } from "./redteam-labels";

export function targetLabel(target: RedTeamTarget): string {
  for (const key of ["title", "name", "base_url"]) {
    const value = target.metadata[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return target.model || target.tool_name || target.target_ref;
}

const normalize = (value: string): string => value.normalize("NFC").trim().toLowerCase();

/** Search only displayed labels and existing inventory identifiers, never arbitrary metadata. */
export function matchesTarget(target: RedTeamTarget, query: string): boolean {
  const needle = normalize(query);
  if (needle === "") return true;
  return [
    target.id,
    target.target_ref,
    target.target_type,
    targetTypeLabel(target.target_type),
    target.risk_level,
    riskLabel(target.risk_level),
    targetLabel(target),
    target.provider,
    target.model,
    target.mcp_upstream,
    target.tool_name,
    target.owner_team,
  ].some((value) => normalize(value).includes(needle));
}

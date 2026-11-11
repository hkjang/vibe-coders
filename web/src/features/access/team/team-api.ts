import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import * as schema from "@/shared/api/domains/team.schemas";
import {
  assertTeamIDs,
  projectTeam,
  teamError,
  teamRouteId,
  validTeamText,
  type TeamWindow,
} from "./team-model";

const api = endpoints.domains.access.team;
export interface TeamRead {
  team: string;
  queryTeam: string;
  window: TeamWindow;
  prefixes: readonly string[];
  signal?: AbortSignal;
}
function options(value: TeamRead, window: TeamWindow | null = value.window) {
  if (
    !validTeamText(value.team, value.prefixes) ||
    (value.queryTeam && !validTeamText(value.queryTeam, value.prefixes))
  )
    throw teamError();
  return {
    signal: value.signal,
    cache: "no-store" as const,
    routeId: teamRouteId,
    query: {
      ...(window ? { window: window === "90d" ? "2160h" : window } : {}),
      ...(value.queryTeam ? { team: value.queryTeam } : {}),
    },
  };
}
export async function readTeamDashboard(value: TeamRead) {
  return projectTeam(
    schema.teamDashboardSchema,
    await apiClient.request(api.dashboard, options(value)),
    value.team,
    value.prefixes,
  );
}
export async function readTeamReports(value: TeamRead) {
  const data = schema.teamReportsSchema.parse(await apiClient.request(api.reports, options(value, null)));
  assertTeamIDs(data.reports, value.prefixes);
  if (data.reports.some((row) => row.team !== value.team)) throw teamError();
  return projectTeam(schema.teamReportsSchema, data, value.team, value.prefixes);
}
export async function readTeamSavings(value: TeamRead) {
  return projectTeam(
    schema.teamSavingsChallengeSchema,
    await apiClient.request(api.savingsChallenge, options(value, null)),
    value.team,
    value.prefixes,
  );
}
export async function readTeamOnboarding(value: TeamRead) {
  return projectTeam(
    schema.teamOnboardingSchema,
    await apiClient.request(api.onboarding, options(value, "90d")),
    value.team,
    value.prefixes,
  );
}
export async function readTeamRisk(value: TeamRead) {
  return projectTeam(
    schema.teamRiskSchema,
    await apiClient.request(api.risk, options(value, "7d")),
    value.team,
    value.prefixes,
  );
}
export async function readTeamSkills(value: TeamRead) {
  return projectTeam(
    schema.teamPopularSkillsSchema,
    await apiClient.request(api.popularSkills, options(value)),
    value.team,
    value.prefixes,
  );
}
export async function readTeamCandidates(value: TeamRead) {
  const request = options(value);
  return projectTeam(
    schema.teamTemplateCandidatesSchema,
    await apiClient.request(api.templateCandidates, {
      ...request,
      query: { ...request.query, min_count: 3 },
    }),
    value.team,
    value.prefixes,
  );
}
export async function readTeamPortal(value: TeamRead) {
  const data = schema.teamPortalSchema.parse(await apiClient.request(api.portal, options(value)));
  assertTeamIDs(data.api_keys, value.prefixes);
  assertTeamIDs(data.pending_skill_requests, value.prefixes);
  return projectTeam(schema.teamPortalSchema, data, value.team, value.prefixes);
}

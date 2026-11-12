import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import * as s from "@/shared/api/domains/me-console.schemas";
import { assertMeIDs, meError, meRouteId, projectMe, validMeText, validMePathID } from "./me-console-model";
export interface MeRead {
  user: string;
  team: string;
  prefixes: readonly string[];
  signal?: AbortSignal;
}
const api = endpoints.domains.access.me;
const options = (value: MeRead) => ({ signal: value.signal, cache: "no-store" as const, routeId: meRouteId });
function own<T extends { user_id: string }>(data: T, value: MeRead): T {
  if (data.user_id !== value.user || !validMeText(data.user_id, value.prefixes, 512)) throw meError();
  return data;
}
export async function readMeDashboard(value: MeRead) {
  const data = own(s.meDashboardSchema.parse(await apiClient.request(api.dashboard, options(value))), value);
  for (const rows of [
    data.recent_failures,
    data.key_alerts,
    data.recommended_templates,
    data.recent_prompt_products,
    data.my_saved_reports,
  ]) {
    assertMeIDs(
      rows.map((row) => row.id),
      value.prefixes,
    );
  }
  if (data.key_alerts.some((row) => row.user_id && row.user_id !== value.user)) throw meError();
  return projectMe(s.meDashboardSchema, data, value.prefixes);
}
export async function readMeActions(value: MeRead) {
  const data = own(s.meActionsSchema.parse(await apiClient.request(api.actions, options(value))), value);
  assertMeIDs(
    data.actions.map((row) => row.type),
    value.prefixes,
  );
  return projectMe(s.meActionsSchema, data, value.prefixes);
}
export async function readMeNotifications(value: MeRead) {
  const data = own(
    s.meNotificationsSchema.parse(await apiClient.request(api.notifications, options(value))),
    value,
  );
  return projectMe(s.meNotificationsSchema, data, value.prefixes);
}
export async function readMeReport(value: MeRead, window: "weekly" | "monthly") {
  const data = own(
    s.meReportSchema.parse(await apiClient.request(api.report, { ...options(value), query: { window } })),
    value,
  );
  if (data.window !== window) throw meError();
  return projectMe(s.meReportSchema, data, value.prefixes);
}
export async function readMeRequests(value: MeRead, limit: number) {
  const data = s.meRequestsSchema.parse(
    await apiClient.request(api.requests, { ...options(value), query: { limit } }),
  );
  assertMeIDs(
    data.requests.map((row) => row.id),
    value.prefixes,
  );
  return projectMe(s.meRequestsSchema, data, value.prefixes);
}
export async function readMeReceipt(value: MeRead, id: string) {
  if (!validMePathID(id, value.prefixes)) throw meError();
  const data = s.meReceiptSchema.parse(
    await apiClient.request(withPathParams(api.receipt, { id }), options(value)),
  );
  if (data.request_id !== id) throw meError();
  return projectMe(s.meReceiptSchema, data, value.prefixes);
}
export async function readMeModels(value: MeRead) {
  return projectMe(
    s.meRecommendedModelsSchema,
    await apiClient.request(api.recommendedModels, options(value)),
    value.prefixes,
  );
}
export async function readMeSkills(value: MeRead) {
  const data = s.meSkillsSchema.parse(await apiClient.request(api.skills, options(value)));
  if (data.team !== value.team) throw meError();
  assertMeIDs(
    [...data.available, ...data.requestable].map((row) => row.name),
    value.prefixes,
  );
  return projectMe(s.meSkillsSchema, data, value.prefixes);
}
export async function readMeRecommendations(value: MeRead, refresh = false) {
  const data = own(
    s.meRecommendationsSchema.parse(
      await apiClient.request(api.recommendations, {
        ...options(value),
        query: { refresh },
        ...(refresh ? { retryUnauthorized: false } : {}),
      }),
    ),
    value,
  );
  assertMeIDs(
    data.recommendations.map((row) => row.id),
    value.prefixes,
  );
  if (data.recommendations.some((row) => row.user_id !== value.user)) throw meError();
  return projectMe(s.meRecommendationsSchema, data, value.prefixes);
}

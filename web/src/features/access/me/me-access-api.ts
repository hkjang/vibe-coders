import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import * as schema from "@/shared/api/domains/me-access.schemas";
import type { MeRead } from "./me-console-api";
import { assertMeIDs, meError, meRouteId, projectMe, validMeText } from "./me-console-model";
import { connectionURLs, type ConnectionClient } from "./me-access-model";
const api = endpoints.domains.access.me;
const options = (scope: MeRead) => ({ routeId: meRouteId, signal: scope.signal, cache: "no-store" as const });
export async function readMeSessions(scope: MeRead) {
  const data = schema.meSessionsSchema.parse(await apiClient.request(api.sessions, options(scope)));
  assertMeIDs(
    data.sessions.map((row) => row.id),
    scope.prefixes,
  );
  if (data.current_session_id && !validMeText(data.current_session_id, scope.prefixes, 512)) throw meError();
  if (
    data.sessions.some(
      (row) => row.current !== undefined && row.current !== (row.id === data.current_session_id),
    )
  )
    throw meError();
  return projectMe(schema.meSessionsSchema, data, scope.prefixes);
}
export async function readMeOnboarding(scope: MeRead, client: ConnectionClient) {
  const data = schema.meOnboardingPackSchema.parse(
    await apiClient.request(api.onboardingPack, { ...options(scope), query: { client } }),
  );
  if (data.client !== client) throw meError();
  const urls = connectionURLs(data.base_url, data.mcp_url, scope.prefixes);
  return projectMe(
    schema.meOnboardingPackSchema,
    { ...data, base_url: urls.baseURL, mcp_url: urls.mcpURL },
    scope.prefixes,
  );
}
export async function inspectMeConnection(scope: MeRead, client: ConnectionClient) {
  const data = schema.meConnectionDoctorSchema.parse(
    await apiClient.request(api.connectionDoctor, {
      ...options(scope),
      body: { client },
      retryUnauthorized: false,
    }),
  );
  if (data.client !== client || new Set(data.checks.map((check) => check.name)).size !== data.checks.length)
    throw meError();
  const urls = connectionURLs(data.base_url, data.mcp_url, scope.prefixes);
  return projectMe(
    schema.meConnectionDoctorSchema,
    { ...data, base_url: urls.baseURL, mcp_url: urls.mcpURL },
    scope.prefixes,
  );
}

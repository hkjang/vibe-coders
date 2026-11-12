import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { meSessionRevokedSchema, meSessionsRevokedSchema } from "@/shared/api/domains/me-access.schemas";
import { assertMeIDs, meRouteId } from "./me-console-model";
import { useMeOperation } from "./use-me-operation";
const api = endpoints.domains.access.me;
const options = { routeId: meRouteId, cache: "no-store" as const, retryUnauthorized: false };
export function useMeRevokeSession() {
  return useMeOperation({
    operation: "sessions",
    invalidates: ["sessions"],
    message: "선택한 세션을 종료했습니다.",
    validate: (input: { id: string; current: string }, prefixes) => {
      assertMeIDs([input.id, input.current], prefixes);
    },
    run: async (input) =>
      meSessionRevokedSchema.parse(
        await apiClient.request(withPathParams(api.revokeSession, { id: input.id }), options),
      ),
    accept: (result, input) => result.session_id === input.id,
  });
}
export function useMeRevokeOtherSessions() {
  return useMeOperation({
    operation: "sessions",
    invalidates: ["sessions"],
    message: "다른 로그인 세션을 종료했습니다.",
    validate: (input: { current: string }, prefixes) => assertMeIDs([input.current], prefixes),
    run: async () => meSessionsRevokedSchema.parse(await apiClient.request(api.revokeOtherSessions, options)),
    accept: () => true,
  });
}

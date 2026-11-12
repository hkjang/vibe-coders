import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import * as schema from "@/shared/api/domains/me-console.schemas";
import type { RecommendationFeedbackBody } from "@/shared/api/domains/access";
import { useMeOperation } from "./use-me-operation";
import { readMeRecommendations } from "./me-console-api";
import { assertMeIDs, meError, meRouteId, validMeText } from "./me-console-model";
const api = endpoints.domains.access.me;
const options = { routeId: meRouteId, cache: "no-store" as const, retryUnauthorized: false };
function checkText(value: string, prefixes: readonly string[], max = 500) {
  if (!validMeText(value, prefixes, max)) throw meError("input");
}
export function useMeSnooze() {
  return useMeOperation({
    operation: "snooze",
    invalidates: ["actions"],
    message: "이 항목을 7일 동안 숨겼습니다.",
    validate: (input: { type: string }, prefixes) => checkText(input.type, prefixes, 120),
    run: async (input) =>
      schema.meSnoozeSchema.parse(
        await apiClient.request(api.snooze, { ...options, body: { type: input.type, days: 7 } }),
      ),
    accept: (result, input) =>
      result.type === input.type && Number.isFinite(Date.parse(result.snoozed_until)),
  });
}
export function useMeGenerateRecommendations() {
  return useMeOperation({
    operation: "recommendations",
    invalidates: ["recommendations", "actions", "notifications"],
    message: "추천을 다시 계산했습니다.",
    validate: (input: undefined) => {
      if (input !== undefined) throw meError("input");
    },
    run: (_input, scope) => readMeRecommendations(scope, true),
    accept: () => true,
  });
}
export function useMeRecommendationFeedback() {
  return useMeOperation({
    operation: "recommendations",
    invalidates: ["actions", "notifications"],
    message: "추천에 대한 의견을 기록했습니다.",
    validate: (
      input: { id: string; kind: string; action: RecommendationFeedbackBody["action"] },
      prefixes,
    ) => {
      assertMeIDs([input.id], prefixes);
      checkText(input.kind, prefixes, 120);
      if (!["adopted", "dismissed", "later"].includes(input.action)) throw meError("input");
    },
    run: async (input) =>
      schema.meRecommendationFeedbackSchema.parse(
        await apiClient.request(withPathParams(api.recommendationFeedback, { id: input.id }), {
          ...options,
          body: { action: input.action },
        }),
      ),
    accept: (result, input) => result.kind === input.kind && result.action === input.action,
  });
}
export function useMeSkillRequest() {
  return useMeOperation({
    operation: "skill-request",
    invalidates: ["skills"],
    message: "스킬 접근 신청을 접수했습니다.",
    validate: (input: { name: string; reason: string }, prefixes) => {
      assertMeIDs([input.name], prefixes);
      checkText(input.reason, prefixes);
    },
    run: async (input) =>
      schema.meSkillActionSchema.parse(
        await apiClient.request(withPathParams(api.requestSkillAccess, { name: input.name }), {
          ...options,
          body: { reason: input.reason },
        }),
      ),
    accept: (result, input) => result.status === "requested" && result.skill === input.name,
  });
}
export function useMeSkillFeedback() {
  return useMeOperation({
    operation: "skill-feedback",
    invalidates: ["skills"],
    message: "스킬 평가를 기록했습니다.",
    validate: (input: { name: string; rating: number; comment: string }, prefixes) => {
      assertMeIDs([input.name], prefixes);
      if (input.comment) checkText(input.comment, prefixes);
      if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw meError("input");
    },
    run: async (input) =>
      schema.meSkillActionSchema.parse(
        await apiClient.request(withPathParams(api.skillFeedback, { name: input.name }), {
          ...options,
          body: { rating: input.rating, ...(input.comment ? { comment: input.comment } : {}) },
        }),
      ),
    accept: (result, input) => result.status === "recorded" && result.skill === input.name,
  });
}

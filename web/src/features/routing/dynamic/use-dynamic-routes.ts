import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import {
  dynamicRouteRejectionSchema,
  type DynamicRouteGraph,
  type DynamicRouteValidation,
} from "@/shared/api/domains/routing-dynamic";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export const dynamicRouteFeatureId = "routing.dynamic";
export const dynamicRoutesKey = ["routing", "dynamic"] as const;
const api = endpoints.domains.routingDynamic;

export function useDynamicRouteList() {
  return useQuery({
    queryKey: [...dynamicRoutesKey, "list"],
    queryFn: ({ signal }) => apiClient.request(api.list, { signal, routeId: dynamicRouteFeatureId }),
  });
}

export function useDynamicRouteDetail(id: string) {
  return useQuery({
    queryKey: [...dynamicRoutesKey, "detail", id],
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(api.detail, { id }), { signal, routeId: dynamicRouteFeatureId }),
  });
}

export function useDynamicRouteActivity(id: string, hours: number, enabled: boolean) {
  return useQuery({
    queryKey: [...dynamicRoutesKey, "activity", id, hours],
    enabled,
    refetchInterval: enabled ? 15_000 : false,
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(api.activity, { id }), {
        query: { hours },
        signal,
        routeId: dynamicRouteFeatureId,
      }),
  });
}

/** Server validation of the graph being edited, 400ms after typing stops. */
export function useDynamicRouteValidation(graph: DynamicRouteGraph | undefined) {
  const text = graph ? JSON.stringify({ elements: graph.elements }) : "";
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(text), 400);
    return () => window.clearTimeout(timer);
  }, [text]);
  return useQuery({
    queryKey: [...dynamicRoutesKey, "validate", settled],
    enabled: settled !== "",
    staleTime: 60_000,
    retry: false,
    queryFn: ({ signal }) =>
      apiClient.request(api.validate, {
        body: { graph: JSON.parse(settled) as DynamicRouteGraph },
        signal,
        routeId: dynamicRouteFeatureId,
      }),
  });
}

/** The per-element validation carried by a 422 rejection, if that is what the error is. */
export function rejectionValidation(error: unknown): DynamicRouteValidation | undefined {
  if (!isAppError(error) || error.status !== 422) return undefined;
  const parsed = dynamicRouteRejectionSchema.safeParse(error.details);
  return parsed.success ? parsed.data.validation : undefined;
}

const errorMessages: Readonly<Record<string, string>> = {
  dynamic_route_conflict:
    "다른 운영자가 먼저 이 경로를 바꿨습니다. 새로고침해서 최신 내용을 확인한 뒤 다시 적용하세요.",
  dynamic_route_name_taken: "같은 이름의 경로가 이미 있습니다.",
  dynamic_route_name_invalid:
    "이름은 영문 소문자·숫자로 시작하고 영문 소문자·숫자·. _ - 만 쓸 수 있습니다(최대 63자).",
  dynamic_route_graph_invalid:
    "경로에 오류가 있어 저장하지 않았습니다. 표시된 요소를 고친 뒤 다시 시도하세요.",
  dynamic_route_version_not_found: "해당 버전을 찾을 수 없습니다.",
  dynamic_route_not_found: "경로를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.",
};

export function dynamicRouteErrorMessage(error: unknown): string {
  if (isAppError(error) && error.code && errorMessages[error.code])
    return errorMessages[error.code] as string;
  return safeAppErrorMessage(error, "요청을 처리하지 못했습니다.");
}

export function useDynamicRouteWrites() {
  const auth = useAuth();
  const canWrite = auth.mode !== "authenticated" || (auth.user?.scopes.includes("routing:write") ?? false);
  const access = useFeatureMutationAccess(
    [dynamicRouteFeatureId],
    canWrite,
    "동적 경로를 바꾸려면 routing:write 권한이 필요합니다.",
  );
  const write = <T>(operation: () => Promise<T>): Promise<T> => {
    access.assertCurrent();
    return operation();
  };
  const listKey = [...dynamicRoutesKey];

  const create = useMutationFeedback({
    mutate: (body: {
      name: string;
      description: string;
      graph: DynamicRouteGraph;
      note: string;
      deploy: boolean;
    }) =>
      write(() =>
        apiClient.request(api.create, { body, routeId: dynamicRouteFeatureId, retryUnauthorized: false }),
      ),
    invalidates: [listKey],
    successMessage: "동적 경로를 만들었습니다.",
    errorFormatter: dynamicRouteErrorMessage,
  });
  const saveVersion = useMutationFeedback({
    mutate: (input: {
      id: string;
      baseVersion: number;
      graph: DynamicRouteGraph;
      note: string;
      deploy: boolean;
    }) =>
      write(() =>
        apiClient.request(withPathParams(api.saveVersion, { id: input.id }), {
          body: {
            base_version: input.baseVersion,
            graph: input.graph,
            note: input.note,
            deploy: input.deploy,
          },
          routeId: dynamicRouteFeatureId,
          retryUnauthorized: false,
        }),
      ),
    invalidates: [listKey],
    errorFormatter: dynamicRouteErrorMessage,
  });
  const deploy = useMutationFeedback({
    mutate: (input: { id: string; version: number; expected: number; reason: string }) =>
      write(() =>
        apiClient.request(withPathParams(api.deploy, { id: input.id }), {
          body: { version: input.version, expected_deployed_version: input.expected, reason: input.reason },
          routeId: dynamicRouteFeatureId,
          retryUnauthorized: false,
        }),
      ),
    invalidates: [listKey],
    errorFormatter: dynamicRouteErrorMessage,
  });
  const update = useMutationFeedback({
    mutate: (input: { id: string; description?: string; enabled?: boolean }) =>
      write(() =>
        apiClient.request(withPathParams(api.update, { id: input.id }), {
          body: {
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          },
          routeId: dynamicRouteFeatureId,
          retryUnauthorized: false,
        }),
      ),
    invalidates: [listKey],
    errorFormatter: dynamicRouteErrorMessage,
  });
  const remove = useMutationFeedback({
    mutate: (id: string) =>
      write(() =>
        apiClient.request(withPathParams(api.remove, { id }), {
          routeId: dynamicRouteFeatureId,
          retryUnauthorized: false,
        }),
      ),
    invalidates: [listKey],
    successMessage: "동적 경로를 삭제했습니다.",
    errorFormatter: dynamicRouteErrorMessage,
  });
  return { access, create, saveVersion, deploy, update, remove } as const;
}

export async function simulateDynamicRoute(body: {
  graph?: DynamicRouteGraph;
  route_id?: string;
  metadata?: Record<string, unknown>;
  identity?: Record<string, string>;
  stream?: boolean;
  failing?: string[];
  exceeded?: string[];
  samples?: number;
}) {
  return apiClient.request(api.simulate, { body, routeId: dynamicRouteFeatureId });
}

export async function loadDynamicRouteVersion(id: string, version: number) {
  return apiClient.request(withPathParams(api.version, { id, version }), { routeId: dynamicRouteFeatureId });
}

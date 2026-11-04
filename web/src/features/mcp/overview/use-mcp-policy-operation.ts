import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { canDeletePolicy, policyFormSchema, policyUnchanged, type PolicyCommand } from "./mcp-policy-review";

const flights = new WeakMap<QueryClient, Set<string>>();
export function useMcpPolicyOperation(owner: FeatureReadOwner, canWrite: boolean) {
  const auth = useAuth();
  const client = useQueryClient();
  const write = useFeatureMutationAccess(
    ["mcp.overview"],
    canWrite && auth.user?.scopes.includes("mcp:admin") === true,
    "MCP 관리 권한(mcp:admin)이 필요합니다.",
  );
  const [conflict, setConflict] = useState(false);
  const principal = JSON.stringify([tokenStore.getSessionEpoch(), auth.mode, auth.user?.id]);
  const assertCurrent = () => {
    assertFeatureRead(owner);
    write.assertCurrent();
  };
  const operation = useMutationFeedback({
    gcTime: 0,
    ownsResult: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    invalidates: [
      ["mcp", "policies"],
      ["mcp", "effective-policy"],
      ["mcp", "overview"],
      ["mcp", "topology"],
    ],
    successMessage: (_result, command: PolicyCommand) =>
      command.kind === "delete"
        ? "정책을 삭제했습니다."
        : command.kind === "allowlist"
          ? "허용목록 모드를 변경했습니다."
          : "정책을 저장했습니다.",
    errorMessage: "MCP 정책을 변경하지 못했습니다.",
    mutate: async (command: PolicyCommand) => {
      assertCurrent();
      if (conflict) throw new AppError("현재 정책을 다시 검토하세요.", { kind: "http", status: 409 });
      if (
        command.kind === "save" &&
        (!policyFormSchema.safeParse(command).success ||
          (command.original && command.original.server_label !== command.server_label))
      )
        throw new AppError("정책 대상과 입력을 다시 확인하세요.", { kind: "contract" });
      if (command.kind === "delete" && !canDeletePolicy(command.original.server_label))
        throw new AppError("기존 삭제 API에서 지원하지 않는 서버 라벨입니다.", { kind: "contract" });
      let active = flights.get(client);
      if (!active) {
        active = new Set();
        flights.set(client, active);
      }
      if (active.has(principal))
        throw new AppError("현재 계정의 MCP 정책 변경이 진행 중입니다.", { kind: "aborted" });
      active.add(principal);
      try {
        const latest = await client.fetchQuery({
          queryKey: featureOwnedKey(["mcp", "policies", "operation-preflight"], owner),
          gcTime: 0,
          staleTime: 0,
          retry: false,
          queryFn: async ({ signal }) => {
            assertFeatureRead(owner, signal);
            const data = await apiClient.request(endpoints.domains.mcp.policies, {
              signal,
              routeId: "mcp.overview",
              retryUnauthorized: false,
            });
            assertFeatureRead(owner, signal);
            return data;
          },
        });
        assertCurrent();
        if (!policyUnchanged(command, latest)) {
          setConflict(true);
          throw new AppError(
            "정책이나 허용목록 기준이 변경되었습니다. 창을 닫고 새로고침한 뒤 다시 검토하세요.",
            { kind: "http", status: 409 },
          );
        }
        if (command.kind === "delete")
          return await apiClient.request(
            withPathParams(endpoints.domains.mcp.deletePolicy, { server: command.original.server_label }),
            { routeId: "mcp.overview", retryUnauthorized: false },
          );
        return await apiClient.request(endpoints.domains.mcp.savePolicy, {
          body:
            command.kind === "allowlist"
              ? { allowlist_enabled: command.enabled }
              : {
                  server_label: command.server_label,
                  mode: command.mode,
                  note: command.note.trim(),
                },
          routeId: "mcp.overview",
          retryUnauthorized: false,
        });
      } finally {
        active.delete(principal);
      }
    },
  });
  return { ...operation, allowed: write.allowed && !conflict, reason: write.reason, conflict, assertCurrent };
}

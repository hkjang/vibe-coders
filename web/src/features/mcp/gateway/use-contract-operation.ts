import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { McpContract } from "@/shared/api/domains/mcp.schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import {
  contractBody,
  contractFingerprint,
  contractFormSchema,
  contractAddressableID,
  type ContractDraft,
} from "./contract-review";

const flights = new WeakMap<QueryClient, Set<string>>();
type Command =
  { kind: "save"; draft: ContractDraft; original?: McpContract } | { kind: "delete"; original: McpContract };
export function useContractOperation(owner: FeatureReadOwner) {
  const auth = useAuth();
  const client = useQueryClient();
  const access = useFeatureMutationAccess(
    ["mcp.gateway"],
    auth.user?.scopes.includes("mcp:admin") === true,
    "MCP 관리 권한(mcp:admin)이 필요합니다.",
  );
  const [conflict, setConflict] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const principal = JSON.stringify([tokenStore.getSessionEpoch(), auth.mode, auth.user?.id]);
  const assertCurrent = () => {
    assertFeatureRead(owner);
    access.assertCurrent();
  };
  const mutation = useMutationFeedback({
    gcTime: 0,
    ownsResult: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    invalidates: [["mcp", "gateway"]],
    successMessage: (_result, command: Command) =>
      command.kind === "delete" ? "도구 계약을 삭제했습니다." : "도구 계약을 저장했습니다.",
    errorMessage: "계약 변경 결과를 확인하지 못했습니다. 목록을 새로 조회하세요.",
    mutate: async (command: Command) => {
      assertCurrent();
      if (command.original && !contractAddressableID(command.original.id))
        throw new AppError("기존 API로 안전하게 지정할 수 없는 계약 ID입니다.", { kind: "contract" });
      if (conflict || attempted) throw new AppError("목록을 다시 검토하세요.", { kind: "aborted" });
      if (
        command.kind === "save" &&
        (!contractFormSchema.safeParse(command.draft).success ||
          command.draft.id !== (command.original?.id ?? ""))
      )
        throw new AppError("계약 입력을 확인하세요.", { kind: "contract" });
      let active = flights.get(client);
      if (!active) {
        active = new Set();
        flights.set(client, active);
      }
      if (active.has(principal)) throw new AppError("계약 변경 중입니다.", { kind: "aborted" });
      active.add(principal);
      try {
        const latest = await client.fetchQuery({
          queryKey: featureOwnedKey(["mcp", "gateway", "contract-preflight"], owner),
          gcTime: 0,
          staleTime: 0,
          retry: false,
          queryFn: async ({ signal }) => {
            assertFeatureRead(owner, signal);
            const data = await apiClient.request(endpoints.domains.mcp.gateway.contracts, {
              query: {},
              signal,
              routeId: "mcp.gateway",
              retryUnauthorized: false,
            });
            assertFeatureRead(owner, signal);
            return data;
          },
        });
        assertCurrent();
        if (
          command.original &&
          contractFingerprint(latest.contracts.find((row) => row.id === command.original?.id)) !==
            contractFingerprint(command.original)
        ) {
          setConflict(true);
          throw new AppError("계약이 바뀌었습니다.", { kind: "http", status: 409 });
        }
        setAttempted(true);
        if (command.kind === "delete")
          return await apiClient.request(endpoints.domains.mcp.gateway.deleteContract, {
            query: { id: command.original.id },
            routeId: "mcp.gateway",
            retryUnauthorized: false,
          });
        const result = await apiClient.request(endpoints.domains.mcp.gateway.saveContract, {
          body: contractBody(command.draft),
          routeId: "mcp.gateway",
          retryUnauthorized: false,
        });
        if (!result.id || (command.original && result.id !== command.original.id))
          throw new AppError("저장 응답을 확인하지 못했습니다.", { kind: "contract" });
        return result;
      } finally {
        active.delete(principal);
      }
    },
  });
  return {
    ...mutation,
    assertCurrent,
    conflict,
    attempted,
    allowed: access.allowed && !conflict && !attempted,
    reason: access.reason,
  };
}

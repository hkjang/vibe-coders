import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { supportsMcpCallLock, withMcpCallLock } from "./mcp-call-lock";
import {
  callable,
  checkedExplanation,
  explanationFingerprint,
  type CallCommand,
  type CallExplanation,
} from "./mcp-call-review";

const flights = new WeakMap<QueryClient, Set<string>>();
export interface CallReview {
  command: CallCommand;
  explanation: CallExplanation;
  revision: number;
}
export function useMcpCall(owner: FeatureReadOwner, canWrite: boolean) {
  const auth = useAuth();
  const client = useQueryClient();
  const revision = useRef(0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [review, setReview] = useState<CallReview>();
  const [conflict, setConflict] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const scope = auth.user?.scopes.includes("mcp:admin") === true;
  const access = useFeatureMutationAccess(
    ["mcp.overview"],
    canWrite && scope,
    "MCP 관리 권한(mcp:admin)이 필요합니다.",
  );
  const principal = JSON.stringify([tokenStore.getSessionEpoch(), auth.mode, auth.user?.id]);
  const assertRead = () => {
    assertFeatureRead(owner);
    if (!mounted.current) throw new AppError("호출 화면이 바뀌었습니다.", { kind: "aborted" });
    if (!scope) throw new AppError("경로 확인에도 MCP 관리 권한이 필요합니다.", { kind: "permission" });
  };
  const explain = useMutationFeedback({
    gcTime: 0,
    ownsResult: ({ version }) => mounted.current && owner.isCurrent() && version === revision.current,
    errorMessage: "적용 경로를 확인하지 못했습니다.",
    mutate: async ({ command, version }: { command: CallCommand; version: number }) => {
      assertRead();
      const result = await apiClient.request(endpoints.domains.mcp.routeExplain, {
        body: command.input,
        routeId: "mcp.overview",
        retryUnauthorized: false,
      });
      assertRead();
      if (version !== revision.current) throw new AppError("입력이 바뀌었습니다.", { kind: "aborted" });
      return { command, explanation: checkedExplanation(result, command.input), revision: version };
    },
    onSuccess: (value) => {
      setReview(value);
      setConflict(false);
      setAttempted(false);
    },
  });
  const run = useMutationFeedback({
    gcTime: 0,
    ownsResult: () => {
      try {
        assertRead();
        access.assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    errorMessage: "테스트 호출 결과를 확인하지 못했습니다. 외부 시스템 상태를 확인하세요.",
    mutate: async (selected: CallReview) => {
      assertRead();
      access.assertCurrent();
      if (selected.revision !== revision.current || conflict || attempted || !callable(selected.explanation))
        throw new AppError("현재 입력과 경로를 다시 검토하세요.", { kind: "contract" });
      let active = flights.get(client);
      if (!active) {
        active = new Set();
        flights.set(client, active);
      }
      if (active.has(principal)) throw new AppError("테스트 호출이 진행 중입니다.", { kind: "aborted" });
      active.add(principal);
      try {
        return await withMcpCallLock(async () => {
          assertRead();
          access.assertCurrent();
          const current = checkedExplanation(
            await apiClient.request(endpoints.domains.mcp.routeExplain, {
              body: selected.command.input,
              routeId: "mcp.overview",
              retryUnauthorized: false,
            }),
            selected.command.input,
          );
          assertRead();
          access.assertCurrent();
          if (selected.revision !== revision.current)
            throw new AppError("입력이 바뀌었습니다.", { kind: "aborted" });
          if (explanationFingerprint(current) !== explanationFingerprint(selected.explanation)) {
            setConflict(true);
            throw new AppError("경로나 정책이 바뀌었습니다. 다시 확인하세요.", { kind: "http", status: 409 });
          }
          // Once dispatched, no blind retry: a lost response may still mean the tool executed.
          setAttempted(true);
          return await apiClient.request(endpoints.domains.mcp.test, {
            body: {
              ...selected.command.input,
              ...(["tools/call", "prompts/get"].includes(selected.command.input.method)
                ? { arguments: selected.command.arguments }
                : {}),
              upstream_id: current.route.upstream_id,
            },
            routeId: "mcp.overview",
            retryUnauthorized: false,
          });
        });
      } finally {
        active.delete(principal);
      }
    },
  });
  const reset = () => {
    revision.current += 1;
    setReview(undefined);
    setConflict(false);
    setAttempted(false);
    explain.reset();
    run.reset();
  };
  const inspect = (command: CallCommand) => {
    reset();
    explain.mutate({ command, version: revision.current });
  };
  return {
    review,
    explain,
    run,
    reset,
    inspect,
    conflict,
    attempted,
    canExplain: scope,
    access,
    lockSupported: supportsMcpCallLock(),
  };
}

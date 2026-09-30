import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompareAccess } from "./use-compare-access";
import { useCompareOperation, type CompareOperationKind } from "./use-compare-operation";
import { chatRouteId } from "./use-chat-console";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import type { MultiRunBody } from "@/shared/api/domains/gateway";
import type {
  MultiRunCodeVerify,
  MultiRunJudge,
  MultiRunPredict,
  MultiRunResponse,
} from "@/shared/api/domains/gateway.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";

interface ComparisonInput {
  body: () => MultiRunBody;
  judgeMethod: "rule" | "model";
  judgeModel: string;
}
interface ComparisonSnapshot {
  response: MultiRunResponse;
  prompt: string;
  requestedModels: MultiRunBody["models"];
}

export function useComparisonConsole(access: CompareAccess, input: ComparisonInput) {
  const [snapshot, setSnapshot] = useState<ComparisonSnapshot>();
  const [predict, setPredict] = useState<MultiRunPredict>();
  const [judge, setJudge] = useState<MultiRunJudge>();
  const [codeRisk, setCodeRisk] = useState<MultiRunCodeVerify>();
  const operation = useCompareOperation(access);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const assertRead = useCallback(() => {
    if (!mounted.current) throw new AppError("이전 비교 화면의 조회를 폐기했습니다.", { kind: "aborted" });
    access.assertRead();
  }, [access]);
  const history = useQuery({
    queryKey: ["gateway", "chat", "multi-runs", access.epoch, access.owner],
    enabled: access.readAllowed,
    retry: false,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      assertRead();
      const result = await apiClient.request(endpoints.domains.gateway.chat.multiRuns, {
        query: { limit: 20 },
        signal,
        routeId: chatRouteId,
      });
      if (!mounted.current || !access.isCurrent())
        throw new AppError("이전 실행 이력 조회를 폐기했습니다.", { kind: "aborted" });
      return result;
    },
  });
  const latest = useRef({ input, snapshot, refetch: history.refetch });
  useLayoutEffect(() => {
    latest.current = { input, snapshot, refetch: history.refetch };
  });

  const call = useCallback(
    async (kind: CompareOperationKind): Promise<void> => {
      const current = latest.current;
      const chat = endpoints.domains.gateway.chat;
      if (kind === "run" || kind === "predict") {
        // Build/copy at admission, before the await. Never read the edited draft
        // when the response arrives or when its Golden form is subsequently opened.
        let requestBody: MultiRunBody | undefined;
        const prepare = (assertAdmission: () => void) => {
          const body = current.input.body();
          requestBody = {
            ...body,
            models: body.models.map((model) => ({ ...model })),
            messages: body.messages?.map((message) => ({ ...message })),
            params: { ...body.params },
          };
          if (
            requestBody.models.length === 0 ||
            (kind === "run" &&
              !(
                requestBody.messages?.filter((message) => message.role === "user").at(-1)?.content ??
                requestBody.prompt ??
                ""
              ).trim())
          )
            throw new AppError("비교할 모델과 사용자 질문을 확인하세요.", { kind: "contract" });
          assertAdmission();
          return requestBody;
        };
        if (kind === "run")
          await operation.execute(
            kind,
            (signal, assertAdmission) =>
              apiClient.request(chat.multiRun, {
                body: prepare(assertAdmission),
                signal,
                routeId: chatRouteId,
              }),
            (response) => {
              if (!requestBody) return;
              setSnapshot({
                response,
                prompt:
                  requestBody.messages?.filter((message) => message.role === "user").at(-1)?.content ??
                  requestBody.prompt ??
                  "",
                requestedModels: requestBody.models,
              });
              setJudge(undefined);
              setCodeRisk(undefined);
              try {
                assertRead();
                void current.refetch();
              } catch {
                /* An admitted result remains valid after read access is revoked. */
              }
            },
          );
        else
          await operation.execute(
            kind,
            (signal, assertAdmission) =>
              apiClient.request(chat.multiRunPredict, {
                body: prepare(assertAdmission),
                signal,
                routeId: chatRouteId,
              }),
            setPredict,
          );
      } else {
        const id = current.snapshot?.response.run_id;
        if (!id) return;
        if (kind === "code")
          await operation.execute(
            kind,
            (signal, assertAdmission) => {
              const endpoint = withPathParams(chat.multiRunCodeVerify, { id });
              assertAdmission();
              return apiClient.request(endpoint, {
                signal,
                routeId: chatRouteId,
              });
            },
            setCodeRisk,
          );
        else
          await operation.execute(
            kind,
            (signal, assertAdmission) => {
              if (current.input.judgeMethod === "model" && !current.input.judgeModel.trim())
                throw new AppError("심사 모델을 입력하세요.", { kind: "contract" });
              const body = {
                run_id: id,
                method: current.input.judgeMethod,
                judge_model:
                  current.input.judgeMethod === "model" ? current.input.judgeModel.trim() : undefined,
              };
              assertAdmission();
              return apiClient.request(chat.multiRunJudge, {
                body,
                signal,
                routeId: chatRouteId,
              });
            },
            setJudge,
          );
      }
    },
    [assertRead, operation],
  );
  const refreshHistory = useCallback(() => {
    try {
      assertRead();
      void history.refetch();
    } catch {
      /* Permission notice is rendered by the consumer. */
    }
  }, [assertRead, history]);
  return {
    run: snapshot?.response,
    runPrompt: snapshot?.prompt ?? "",
    predict,
    judge,
    codeRisk,
    history,
    refreshHistory,
    call,
    pending: operation.pending,
    error: operation.error,
  };
}

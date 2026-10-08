import type { Query, QueryKey } from "@tanstack/react-query";

import { AppError, isAppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { ownsLLMQuery, type LLMReadOwner } from "./llm-read-access";

export function assertLLMReadOwner(owner: LLMReadOwner, signal?: AbortSignal): void {
  if (signal?.aborted || !owner.isCurrent())
    throw new AppError("이전 사용자 범위의 LLM 작업을 종료했습니다.", { kind: "aborted" });
}

export function llmReadError(error: unknown, owner: LLMReadOwner): AppError {
  return new AppError("LLM 자료를 확인하지 못했습니다. 현재 조회 권한을 확인한 뒤 다시 시도하세요.", {
    kind: isAppError(error) ? error.kind : "network",
    status: isAppError(error) ? error.status : undefined,
    retryable: isAppError(error) && error.retryable,
    requestId:
      isAppError(error) && error.requestId && !containsPotentialSecret(error.requestId, owner.prefixes)
        ? error.requestId
        : undefined,
  });
}

export function llmReadQueryOptions<T>(
  owner: LLMReadOwner,
  key: QueryKey,
  request: (signal: AbortSignal) => Promise<T>,
) {
  return {
    queryKey: [...key, "llm-read-owner", owner.id],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<T> => {
      assertLLMReadOwner(owner, signal);
      try {
        const result = await request(signal);
        assertLLMReadOwner(owner, signal);
        return result;
      } catch (error) {
        assertLLMReadOwner(owner, signal);
        throw llmReadError(error, owner);
      }
    },
    placeholderData: (previous: T | undefined, query: Query<T> | undefined) =>
      query && ownsLLMQuery(query.queryKey, owner) ? previous : undefined,
  };
}

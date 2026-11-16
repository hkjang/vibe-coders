import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret } from "@/shared/security/secrets";

/** Both dialogs and toast feedback receive only a safe operational error. */
export function healthDisplayError(error: unknown, prefixes: readonly string[] = []): AppError {
  const source = isAppError(error) ? error : undefined;
  const requestId = source?.requestId;
  return new AppError(safeAppErrorMessage(error, "운영 상태 작업을 완료하지 못했습니다."), {
    kind: source?.kind ?? "network",
    status: source?.status,
    retryable: source?.retryable,
    requestId:
      requestId && requestId.length <= 200 && !containsPotentialSecret(requestId, prefixes)
        ? requestId
        : undefined,
  });
}

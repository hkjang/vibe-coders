import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { AppError } from "@/shared/api/error";

/** UI send latch, not a server idempotency key or proof that a failed response did not commit. */
export function useChangeSetCreateAttempt(queryKey: QueryKey, assertAccess: () => void) {
  const client = useQueryClient();
  const attempt = useRef({ sent: false, pending: false });
  const [sent, setSent] = useState(false);
  const fresh = () => {
    const state = client.getQueryState(queryKey);
    return state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated;
  };
  return {
    sent,
    begin: () => {
      if (attempt.current.pending || !fresh()) return false;
      attempt.current = { sent: false, pending: false };
      setSent(false);
      return true;
    },
    claim: () => {
      assertAccess();
      if (attempt.current.sent || !fresh())
        throw new AppError("같은 생성 요청을 다시 보내지 않습니다. 목록을 확인한 뒤 새로 작성하세요.", {
          kind: "aborted",
        });
      attempt.current.sent = true;
      attempt.current.pending = true;
      setSent(true);
    },
    finish: () => {
      attempt.current.pending = false;
    },
  };
}

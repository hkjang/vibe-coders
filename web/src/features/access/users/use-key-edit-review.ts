import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { accessKeys } from "./use-access-admin";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { AppError } from "@/shared/api/error";

export const keyEditReasonSchema = z
  .string()
  .trim()
  .min(1, "변경 사유를 입력하세요.")
  .refine((value) => [...value].length <= 1024, "변경 사유는 1,024자 이하로 입력하세요.");

interface Catalog {
  api_keys: ApiKeyPublic[];
  edit_review_supported?: boolean;
}

export function useKeyEditReview(target: Pick<ApiKeyPublic, "id" | "revision">, owner?: string) {
  const client = useQueryClient();
  const [baseline] = useState(() => ({ ...target }));
  const [attempted, setAttempted] = useState(false);
  const attempt = useRef(false);
  const confirmation = useRef<HTMLInputElement>(null);
  const state = useSyncExternalStore(
    useCallback((notify) => client.getQueryCache().subscribe(notify), [client]),
    useCallback(
      () => client.getQueryState<Catalog>(owner ? [...accessKeys.apiKeys, owner] : accessKeys.apiKeys),
      [client, owner],
    ),
  );
  function isCurrent() {
    const current = client.getQueryState<Catalog>(
      owner ? [...accessKeys.apiKeys, owner] : accessKeys.apiKeys,
    );
    const matches = current?.data?.api_keys.filter((row) => row.id === baseline.id) ?? [];
    return (
      current?.status === "success" &&
      current.fetchStatus === "idle" &&
      !current.isInvalidated &&
      current.data?.edit_review_supported === true &&
      /^[a-f0-9]{64}$/.test(baseline.revision) &&
      matches.length === 1 &&
      matches[0]?.revision === baseline.revision &&
      matches[0]?.status !== "revoked"
    );
  }
  return {
    ready: state !== undefined && isCurrent(),
    attempted,
    confirmation,
    begin: (reason: string, allowed: boolean) => {
      const checked = keyEditReasonSchema.safeParse(reason);
      if (!allowed || !isCurrent() || attempt.current || !confirmation.current?.checked || !checked.success)
        throw new AppError("최신 키 정보, 변경 사유와 변경 내용 확인을 다시 검토하세요.", {
          kind: "aborted",
          code: "key_edit_review_required",
        });
      attempt.current = true;
      setAttempted(true);
      return { reason: checked.data, expected_revision: baseline.revision };
    },
  };
}

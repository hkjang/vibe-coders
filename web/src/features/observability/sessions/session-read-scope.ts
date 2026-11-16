import { useState } from "react";
import { isAppError } from "@/shared/api/error";
import { assertFeatureRead, useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { containsPotentialSecret } from "@/shared/security/secrets";
import type { SessionListAccess } from "./session-list-access";

/** List periods share one scope; an open recorder has an independent scope. */
export function useSessionReadScope(
  access: SessionListAccess,
  marker: "session-list-read" | "session-flight-read",
) {
  const owner = useFeatureReadOwner("observability.sessions", marker);
  const [diagnostic, setDiagnostic] = useState<{ owner: number; requestId?: string }>();
  const assertCurrent = (signal?: AbortSignal) => {
    access.assertRead();
    assertFeatureRead(owner, signal);
  };
  const captureDenial = (error: unknown) => {
    assertCurrent();
    if (!isAppError(error) || (error.status !== 401 && error.status !== 403)) return;
    const id = error.requestId;
    setDiagnostic({
      owner: owner.id,
      requestId:
        id && /^[A-Za-z0-9_-]{1,128}$/u.test(id) && !containsPotentialSecret(id, access.prefixes)
          ? id
          : undefined,
    });
  };
  const restart = () => {
    try {
      access.assertRead();
      owner.restart();
    } catch {
      /* An inactive scope cannot restart a read. */
    }
  };
  return {
    owner,
    assertCurrent,
    captureDenial,
    restart,
    requestId: diagnostic?.owner === owner.id ? diagnostic.requestId : undefined,
  };
}

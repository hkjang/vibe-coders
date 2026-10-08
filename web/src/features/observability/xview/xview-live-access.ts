import { useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";

export interface XViewReadOwner {
  readable: boolean;
  prefixes?: readonly string[];
  isCurrent: () => boolean;
  onDenied?: () => void;
  resumeDraft?: () => void;
}

/** A read lifetime, not an authorization policy. Masked admin:read stays supported. */
export function useXViewReadOwner(): XViewReadOwner {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const readable =
    (auth.mode === "authenticated" || auth.mode === "legacy" || auth.mode === "open") &&
    context?.featureId === "observability.xview" &&
    context.permitted &&
    (auth.mode !== "authenticated" || auth.user?.scopes.includes("admin:read") === true);
  const key = JSON.stringify([
    epoch,
    readable,
    context?.featureId,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
    auth.capabilities.raw_prompt_view,
    auth.credentialPrefixes,
  ]);
  const current = useRef<XViewReadOwner | undefined>(undefined);
  const owner = useMemo<XViewReadOwner>(() => {
    const value = {
      readable,
      prefixes: auth.credentialPrefixes,
      isCurrent: () => current.current === value && value.readable && epoch === tokenStore.getSessionEpoch(),
    };
    return value;
    // key intentionally excludes write permission/read-only mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useLayoutEffect(() => {
    current.current = owner;
    return () => {
      current.current = undefined;
    };
  }, [owner]);
  return owner;
}

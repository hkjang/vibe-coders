import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { UseFormReturn } from "react-hook-form";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { ProviderConnectionResult } from "@/shared/api/domains/provider-connection.schemas";
import { isAppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import type { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import {
  connectionFailureLabels,
  connectionFields,
  providerConnectionInput,
} from "./provider-connection-state";
import type { ProviderCatalogRow } from "./provider-catalog";
import type { ProviderFormInput, ProviderFormOutput } from "./provider-form";
import { useProviderWriteAccess } from "./use-provider-write-access";

interface Result {
  value: ProviderConnectionResult;
  revision: number;
  mode: "draft" | "stored" | "none";
}
export function useProviderConnection(
  form: UseFormReturn<ProviderFormInput, unknown, ProviderFormOutput>,
  row: ProviderCatalogRow | undefined,
  guard: ReturnType<typeof useDraftGuard>,
) {
  const access = useProviderWriteAccess();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);
  const [noKey, setNoKey] = useState(false);
  const noKeyRef = useRef(false);
  const [hasDraftKey, setHasDraftKey] = useState(false);
  const [phase, setPhase] = useState<"idle" | "validation" | "request">("idle");
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const lifetime = useRef<object>({});
  const activeRun = useRef<object | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  const owner = context?.featureId;
  const permitted = context?.permitted === true;
  useLayoutEffect(() => {
    mounted.current = true;
    lifetime.current = {};
    return () => {
      mounted.current = false;
      lifetime.current = {};
      // Result ownership expires here, but this run still owns its pending
      // presentation until settlement. Unmount is fenced by mounted below.
      abort.current?.abort();
    };
  }, [epoch, owner, permitted]);
  const { watch } = form;
  useEffect(() => {
    const subscription = watch((values, info) => {
      if (info.name && !connectionFields.some((field) => field === info.name)) return;
      revisionRef.current += 1;
      setRevision(revisionRef.current);
      noKeyRef.current = false;
      setNoKey(false);
      setHasDraftKey((values.api_key ?? "").trim() !== "");
      setError(undefined);
    });
    return () => subscription.unsubscribe();
  }, [watch]);
  const acknowledgeNoKey = (checked: boolean): void => {
    if (guard.pending || !access.allowed) return;
    revisionRef.current += 1;
    setRevision(revisionRef.current);
    noKeyRef.current = checked;
    setNoKey(checked);
    setError(undefined);
  };
  const run = (): void => {
    const runToken = {};
    // The same synchronous draft guard owns testing, reviewing and saving.
    const completion = guard.run(
      async () => {
        access.assertCurrent();
        activeRun.current = runToken;
        const instance = lifetime.current;
        const expectedRevision = revisionRef.current;
        const current = (): boolean =>
          mounted.current && lifetime.current === instance && epoch === tokenStore.getSessionEpoch();
        setError(undefined);
        setResult(undefined);
        setPhase("validation");
        try {
          const valid = await form.trigger([...connectionFields], { shouldFocus: true });
          if (!current() || expectedRevision !== revisionRef.current) return undefined;
          access.assertCurrent();
          if (!valid) return undefined;
          const input = providerConnectionInput(form.getValues(), row, noKeyRef.current);
          if ("issue" in input) {
            form.setError(input.issue.field, { type: "connection", message: input.issue.message });
            form.setFocus(input.issue.field);
            return undefined;
          }
          const controller = new AbortController();
          abort.current = controller;
          access.assertCurrent();
          if (!current() || expectedRevision !== revisionRef.current) return undefined;
          setPhase("request");
          const mode = input.body.credential_mode;
          // Direct API call: no TanStack mutation variables/cache containing draft secrets.
          const value = await apiClient.request(endpoints.domains.gateway.providers.connectionTest, {
            body: input.body,
            signal: controller.signal,
            routeId: "gateway.providers",
          });
          access.assertCurrent();
          // Never publish a late result across current authorization, ownership,
          // session or input boundaries. Recovery requires a new manual test.
          return current() && expectedRevision === revisionRef.current
            ? { value, revision: expectedRevision, mode }
            : undefined;
        } catch (cause) {
          if (current() && (!isAppError(cause) || cause.kind !== "aborted")) {
            const code = isAppError(cause) ? cause.code : undefined;
            setError({
              message:
                code && Object.hasOwn(connectionFailureLabels, code)
                  ? (connectionFailureLabels[code] ?? "연결 테스트를 실행하지 못했습니다.")
                  : safeAppErrorMessage(cause, "연결 테스트를 실행하지 못했습니다."),
              requestId: isAppError(cause) ? cause.requestId : undefined,
            });
          }
          return undefined;
        } finally {
          if (activeRun.current === runToken) {
            abort.current = undefined;
          }
        }
      },
      () => undefined,
      (value) => {
        if (value) setResult(value);
      },
    );
    void completion.finally(() => {
      if (mounted.current && activeRun.current === runToken) {
        activeRun.current = undefined;
        // Keep invalid inputs focusable until the shared guard is no longer
        // pending. A refused duplicate must not finish the admitted run.
        setPhase("idle");
      }
    });
  };
  return {
    run,
    phase,
    result,
    error,
    stale: result !== undefined && result.revision !== revision,
    noKey,
    acknowledgeNoKey,
    allowNoKey: !row?.provider.api_key_configured && !hasDraftKey,
  };
}

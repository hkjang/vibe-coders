import { useLayoutEffect, type ComponentProps, type PropsWithChildren } from "react";
import type { RouterProvider } from "react-router/dom";
import { useAuth } from "@/app/auth/AuthProvider";
import { featureByPath, resolveFeature, versionAtLeast } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { tokenStore } from "@/shared/auth/token-store";
import { installActionSink } from "@/shared/telemetry/action-channel";

export function ConsoleActions({
  router,
  children,
}: PropsWithChildren<{
  router: ComponentProps<typeof RouterProvider>["router"];
}>): React.JSX.Element {
  const auth = useAuth();
  useLayoutEffect(() => {
    if (
      !auth.telemetryEnabled ||
      !auth.uiEnabled ||
      !["authenticated", "legacy", "open"].includes(auth.mode) ||
      !versionAtLeast(auth.backendVersion, "v0.86.181")
    )
      return;
    const epoch = tokenStore.getSessionEpoch();
    const current = () => epoch === tokenStore.getSessionEpoch();
    return installActionSink(
      () => {
        if (!current()) return;
        const feature = featureByPath(router.state.location.pathname, auth.features);
        if (
          feature &&
          resolveFeature(feature, auth.user, auth.backendVersion, {
            legacyFallback: auth.legacyFallback,
          }).permitted
        )
          return feature.featureId;
      },
      current,
      (event) => {
        if (!current()) return;
        let nonce: string;
        try {
          nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        } catch {
          return;
        }
        void apiClient
          .request(endpoints.uiActions.events, {
            body: { ...event, event_id: nonce },
            routeId: "ui.actions",
            keepalive: true,
            referrerPolicy: "no-referrer",
            retryUnauthorized: false,
            timeoutMs: 2_000,
          })
          .catch(() => undefined);
      },
    );
  }, [auth, router]);
  return <>{children}</>;
}

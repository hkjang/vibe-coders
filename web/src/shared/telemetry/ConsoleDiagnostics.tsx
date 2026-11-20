import { useLayoutEffect, type ComponentProps, type PropsWithChildren } from "react";
import type { RouterProvider } from "react-router/dom";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppErrorBoundary } from "@/app/error-boundaries/AppErrorBoundary";
import { featureByPath, resolveFeature, versionAtLeast } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { tokenStore } from "@/shared/auth/token-store";
import { installDiagnosticSink, reportBoundaryError } from "@/shared/telemetry/diagnostic-channel";

const rootError = (error: unknown) => reportBoundaryError(error, "root");

export function ConsoleDiagnostics({
  router,
  children,
}: PropsWithChildren<{ router: ComponentProps<typeof RouterProvider>["router"] }>): React.JSX.Element {
  const auth = useAuth();
  useLayoutEffect(() => {
    if (
      !auth.telemetryEnabled ||
      !auth.uiEnabled ||
      !["authenticated", "legacy", "open"].includes(auth.mode) ||
      !versionAtLeast(auth.backendVersion, "v0.86.180")
    )
      return;
    const epoch = tokenStore.getSessionEpoch();
    return installDiagnosticSink(
      () => {
        if (tokenStore.getSessionEpoch() !== epoch) return;
        const feature = featureByPath(router.state.location.pathname, auth.features);
        if (
          feature &&
          resolveFeature(feature, auth.user, auth.backendVersion, { legacyFallback: auth.legacyFallback })
            .permitted
        )
          return feature.featureId;
      },
      (event) => {
        if (tokenStore.getSessionEpoch() !== epoch) return;
        let nonce: string;
        try {
          nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        } catch {
          return;
        }
        void apiClient
          .request(endpoints.uiDiagnostics.events, {
            body: { ...event, event_id: nonce },
            routeId: "ui.diagnostics",
            keepalive: true,
            referrerPolicy: "no-referrer",
            retryUnauthorized: false,
            timeoutMs: 2_000,
          })
          .catch(() => undefined);
      },
    );
  }, [auth, router]);
  return <AppErrorBoundary onError={rootError}>{children}</AppErrorBoundary>;
}

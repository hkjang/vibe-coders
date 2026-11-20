import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterProvider } from "@/app/router/AppRouterProvider";

import { AppErrorBoundary } from "@/app/error-boundaries/AppErrorBoundary";
import { AppProviders } from "@/app/providers/AppProviders";
import { initializeAppearance } from "@/app/providers/theme";
import { createAppRouter } from "@/app/router/router";
import { ConsoleDiagnostics } from "@/shared/telemetry/ConsoleDiagnostics";
import { logCaughtReactError } from "@/shared/telemetry/react-error-log";
import { sanitizeWindowAppLocationBeforeBootstrap } from "@/shared/security/app-route-query";
import "@/shared/styles/globals.css";
import "@/shared/styles/foundation.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root application mount point");
sanitizeWindowAppLocationBeforeBootstrap();
initializeAppearance();
const router = createAppRouter();

createRoot(root, { onCaughtError: logCaughtReactError }).render(
  <StrictMode>
    <AppErrorBoundary>
      <AppProviders>
        <ConsoleDiagnostics router={router}>
          <AppRouterProvider router={router} onError={logCaughtReactError} />
        </ConsoleDiagnostics>
      </AppProviders>
    </AppErrorBoundary>
  </StrictMode>,
);

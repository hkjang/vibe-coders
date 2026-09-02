import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { AppErrorBoundary } from "@/app/error-boundaries/AppErrorBoundary";
import { AppProviders } from "@/app/providers/AppProviders";
import { createAppRouter } from "@/app/router/router";
import { sanitizeWindowAppLocationBeforeBootstrap } from "@/shared/security/app-route-query";
import "@/shared/styles/globals.css";
import "@/shared/styles/foundation.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root application mount point");
sanitizeWindowAppLocationBeforeBootstrap();
const router = createAppRouter();

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </AppErrorBoundary>
  </StrictMode>,
);

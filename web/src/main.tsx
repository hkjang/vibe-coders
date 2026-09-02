import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { AppErrorBoundary } from "@/app/error-boundaries/AppErrorBoundary";
import { AppProviders } from "@/app/providers/AppProviders";
import { router } from "@/app/router/router";
import "@/shared/styles/globals.css";
import "@/shared/styles/foundation.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root application mount point");

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </AppErrorBoundary>
  </StrictMode>,
);

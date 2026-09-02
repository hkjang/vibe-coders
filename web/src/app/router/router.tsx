import { createBrowserRouter, type RouteObject } from "react-router";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { ProtectedRoute } from "@/app/guards/ProtectedRoute";
import { AppShell } from "@/app/layouts/AppShell";
import { DefaultEntryRedirect } from "@/app/router/DefaultEntryRedirect";
import { NotFoundPage, RouteErrorPage } from "@/app/router/RouteErrorPage";
import { featurePath, migrationRegistry } from "@/config/migration-registry";

const featureRoutes: RouteObject[] = migrationRegistry.map((feature) => {
  const path = featurePath(feature).replace(/^\//, "");
  if (feature.featureId === "overview") {
    return {
      path,
      lazy: async () => {
        const { OverviewPage } = await import("@/features/overview/OverviewPage");
        return {
          Component: () => (
            <FeatureRoute feature={feature}>
              <OverviewPage />
            </FeatureRoute>
          ),
        };
      },
    };
  }
  if (feature.featureId === "gateway.health") {
    return {
      path,
      lazy: async () => {
        const { GatewayHealthPage } = await import("@/features/gateway/health/GatewayHealthPage");
        return {
          Component: () => (
            <FeatureRoute feature={feature}>
              <GatewayHealthPage />
            </FeatureRoute>
          ),
        };
      },
    };
  }
  if (feature.featureId === "system.health") {
    return {
      path,
      lazy: async () => {
        const { SystemHealthPage } = await import("@/features/system/health/SystemHealthPage");
        return {
          Component: () => (
            <FeatureRoute feature={feature}>
              <SystemHealthPage />
            </FeatureRoute>
          ),
        };
      },
    };
  }
  return { path, element: <FeatureRoute feature={feature} /> };
});

export const router = createBrowserRouter(
  [
    {
      path: "login",
      lazy: async () => {
        const { LoginPage } = await import("@/app/auth/LoginPage");
        return { Component: LoginPage };
      },
      errorElement: <RouteErrorPage />,
    },
    {
      element: <ProtectedRoute />,
      errorElement: <RouteErrorPage />,
      children: [
        {
          element: <AppShell />,
          children: [
            { index: true, element: <DefaultEntryRedirect /> },
            ...featureRoutes,
            { path: "*", element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ],
  { basename: "/app" },
);

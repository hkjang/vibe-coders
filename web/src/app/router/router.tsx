import { createBrowserRouter, type RouteObject } from "react-router";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { ProtectedRoute } from "@/app/guards/ProtectedRoute";
import { RouteQueryGuard } from "@/app/guards/RouteQueryGuard";
import { AppShell } from "@/app/layouts/AppShell";
import { CompatibilityRedirect } from "@/app/router/CompatibilityRedirect";
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
  if (feature.featureId === "gateway.providers") {
    return {
      path,
      lazy: async () => {
        const { ProviderPage } = await import("@/features/gateway/providers/ProviderPage");
        return {
          Component: () => (
            <FeatureRoute feature={feature}>
              <ProviderPage />
            </FeatureRoute>
          ),
        };
      },
    };
  }
  if (feature.featureId === "gateway.models") {
    return {
      path,
      lazy: async () => {
        const { ModelPage } = await import("@/features/gateway/models/ModelPage");
        return {
          Component: () => (
            <FeatureRoute feature={feature}>
              <ModelPage />
            </FeatureRoute>
          ),
        };
      },
    };
  }
  if (feature.featureId === "observability.requests") {
    return {
      path,
      lazy: async () => {
        const { RequestPage } = await import("@/features/observability/requests/RequestPage");
        return {
          Component: () => (
            <FeatureRoute feature={feature}>
              <RequestPage />
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

export function createAppRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(
    [
      {
        element: <RouteQueryGuard />,
        children: [
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
                  { path: "providers", element: <CompatibilityRedirect to="/gateway/providers" /> },
                  { path: "models", element: <CompatibilityRedirect to="/gateway/models" /> },
                  ...featureRoutes,
                  { path: "*", element: <NotFoundPage /> },
                ],
              },
            ],
          },
        ],
      },
    ],
    { basename: "/app" },
  );
}

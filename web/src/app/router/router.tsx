import type { ComponentType } from "react";
import { createBrowserRouter, type RouteObject } from "react-router";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { ProtectedRoute } from "@/app/guards/ProtectedRoute";
import { RouteQueryGuard } from "@/app/guards/RouteQueryGuard";
import { AppShell } from "@/app/layouts/AppShell";
import { CompatibilityRedirect } from "@/app/router/CompatibilityRedirect";
import { DefaultEntryRedirect } from "@/app/router/DefaultEntryRedirect";
import { NotFoundPage, RouteErrorPage } from "@/app/router/RouteErrorPage";
import { UnsavedChangesBoundary } from "@/app/router/UnsavedChangesBoundary";
import { featurePath, migrationRegistry, type MigrationFeature } from "@/config/migration-registry";
import { featureModule } from "@/features/registry";

function featureRoute(feature: MigrationFeature): RouteObject {
  const path = featurePath(feature).replace(/^\//, "");
  const module = featureModule(feature.featureId);
  if (!module) return { path, element: <FeatureRoute feature={feature} /> };
  const load = (loader: () => Promise<ComponentType>) => async (): Promise<{ Component: ComponentType }> => {
    const Screen = await loader();
    return {
      Component: () => (
        <FeatureRoute feature={feature}>
          <Screen />
        </FeatureRoute>
      ),
    };
  };
  const lazy = load(module.load);
  // Screens own their sub-paths (tabs, detail segments) and read them with
  // useParams/useLocation, so both the exact path and its descendants resolve here.
  return {
    path,
    children: [
      { index: true, lazy },
      ...(module.subroutes ?? []).map((screen) => ({ path: screen.path, lazy: load(screen.load) })),
      { path: "*", lazy },
    ],
  };
}

const featureRoutes: RouteObject[] = migrationRegistry.map(featureRoute);

export function createAppRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(
    [
      {
        element: <UnsavedChangesBoundary />,
        children: [
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
      },
    ],
    { basename: "/app" },
  );
}

import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the system domain. Register each implemented feature here.
export const systemFeatureModules = defineFeatureModules([
  {
    featureId: "system.secrets",
    load: () =>
      import("@/features/system/secrets/SecretRotationPage").then((module) => module.SecretRotationPage),
    // The key itself must never be a route parameter.
    queryKeys: [],
  },
  {
    featureId: "system.health",
    load: () => import("@/features/system/health/SystemHealthPage").then((module) => module.SystemHealthPage),
    queryKeys: ["range", "tab"],
  },
  {
    featureId: "system.settings",
    load: () =>
      import("@/features/system/settings/SystemSettingsPage").then((module) => module.SystemSettingsPage),
    queryKeys: ["category", "limit", "q", "setting", "tab", "telemetry_days"],
  },
]);

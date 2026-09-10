import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the system domain. Register each implemented feature here.
export const systemFeatureModules = defineFeatureModules([
  {
    featureId: "system.health",
    load: () => import("@/features/system/health/SystemHealthPage").then((module) => module.SystemHealthPage),
    queryKeys: ["range", "tab"],
  },
  {
    featureId: "system.settings",
    load: () =>
      import("@/features/system/settings/SystemSettingsPage").then((module) => module.SystemSettingsPage),
    queryKeys: ["category", "limit", "q", "tab"],
  },
]);

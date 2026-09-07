import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the finops domain. Register each implemented feature here.
export const finopsFeatureModules = defineFeatureModules([
  {
    featureId: "finops.overview",
    load: () => import("./overview/FinopsPage").then((module) => module.FinopsPage),
    queryKeys: ["dimension", "month", "tab", "window"],
  },
]);

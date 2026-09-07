import { defineFeatureModules } from "@/features/feature-module";

// The combined operations overview. It reads across domains, so it owns no
// domain of its own and is registered from here.
export const overviewFeatureModules = defineFeatureModules([
  {
    featureId: "overview",
    load: () => import("./OverviewPage").then((module) => module.OverviewPage),
    queryKeys: ["range", "tab"],
  },
]);

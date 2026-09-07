import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the routing domain. Register each implemented feature here.
export const routingFeatureModules = defineFeatureModules([
  {
    featureId: "routing.rules",
    load: () => import("./rules/RoutingPage").then((module) => module.RoutingPage),
    // Tabs live in sub-paths (/routing/rules/<tab>); these keys are the filters
    // each tab keeps in the URL so a screen can be shared as a link.
    queryKeys: ["limit", "model", "page", "route", "status", "threshold", "window"],
  },
]);

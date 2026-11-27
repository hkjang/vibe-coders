import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the work-insights domain. Register each implemented feature here.
export const insightsFeatureModules = defineFeatureModules([
  {
    featureId: "insights.usage",
    load: () => import("@/features/insights/usage/UsagePage").then((module) => module.UsagePage),
    queryKeys: [
      "tab",
      "days",
      "from",
      "to",
      "compare",
      "team",
      "category",
      "action",
      "model",
      "client",
      "metric",
      "bucket",
      "parent",
      "list",
      "page",
      "sort",
      "session_status",
      "status",
      "conf",
      "review",
      "session",
      "candidate",
    ],
  },
  {
    featureId: "insights.classification",
    load: () =>
      import("@/features/insights/classification/ClassificationPage").then(
        (module) => module.ClassificationPage,
      ),
    queryKeys: ["tab", "status", "category", "max_conf", "page", "from", "to", "method", "job", "version"],
  },
]);

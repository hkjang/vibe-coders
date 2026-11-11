import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the prompts domain. Register each implemented feature here.
export const promptsFeatureModules = defineFeatureModules([
  {
    featureId: "prompts.regression",
    load: () => import("./regression/RegressionPage").then((module) => module.RegressionPage),
    queryKeys: ["tab", "page", "limit", "outcome", "selection"],
  },
  {
    featureId: "prompts.library",
    load: () =>
      import("@/features/prompts/library/PromptLibraryPage").then((module) => module.PromptLibraryPage),
    queryKeys: [
      "api_key_id",
      "asset",
      "asset_category",
      "asset_q",
      "asset_status",
      "asset_tag",
      "debt_window",
      "fp_window",
      "ip",
      "language",
      "limit",
      "q",
      "since",
      "tab",
    ],
  },
]);

import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the text2sql domain. Register each implemented feature here.
export const text2sqlFeatureModules = defineFeatureModules([
  {
    featureId: "text2sql.overview",
    load: () => import("./overview/Text2SqlPage").then((module) => module.Text2SqlPage),
    // Questions, generated SQL and rejection reasons never reach the URL.
    queryKeys: ["tab", "window", "schema", "min_risk"],
  },
]);

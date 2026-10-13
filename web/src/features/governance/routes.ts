import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the governance domain. Register each implemented feature here.
export const governanceFeatureModules = defineFeatureModules([
  {
    featureId: "governance.reports",
    load: () => import("./reports/ReportsPage").then((module) => module.ReportsPage),
    queryKeys: ["tab", "window"],
  },
  {
    featureId: "governance.assets",
    load: () => import("./assets/AssetsPage").then((module) => module.AssetsPage),
    queryKeys: ["tab", "type", "user", "window"],
  },
  {
    featureId: "governance.policies",
    load: () => import("./policies/PoliciesPage").then((module) => module.PoliciesPage),
    subroutes: [
      {
        path: "advisor",
        load: () => import("./policies/PolicyAdvisorPage").then((module) => module.PolicyAdvisorPage),
      },
      {
        path: "detail",
        load: () => import("./policies/PolicySearchPage").then((module) => module.PolicySearchPage),
      },
    ],
    queryKeys: [
      "advisor_window",
      "approval_status",
      "canary_days",
      "decision",
      "policy",
      "secret_action",
      "tab",
      "window",
    ],
  },
  {
    featureId: "governance.remediation",
    load: () => import("./remediation/RemediationPage").then((module) => module.RemediationPage),
    queryKeys: ["window"],
  },
]);

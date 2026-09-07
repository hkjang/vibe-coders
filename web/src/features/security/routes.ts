import { defineFeatureModules } from "@/features/feature-module";
import { securityOverviewQueryKeys } from "@/features/security/overview/security-overview";

// Screens owned by the security domain. Register each implemented feature here.
export const securityFeatureModules = defineFeatureModules([
  {
    featureId: "security.overview",
    load: () =>
      import("@/features/security/overview/SecurityOverviewPage").then(
        (module) => module.SecurityOverviewPage,
      ),
    queryKeys: securityOverviewQueryKeys,
  },
  {
    featureId: "security.redteam",
    load: () => import("@/features/security/redteam/RedTeamPage").then((module) => module.RedTeamPage),
    queryKeys: ["tab", "q"],
  },
  {
    featureId: "security.sandbox",
    load: () => import("@/features/security/sandbox/SandboxPage").then((module) => module.SandboxPage),
  },
]);

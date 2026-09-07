import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the agents domain. Register each implemented feature here.
export const agentsFeatureModules = defineFeatureModules([
  {
    featureId: "agents.workflows",
    load: () => import("@/features/agents/workflows/WorkflowPage").then((module) => module.WorkflowPage),
    queryKeys: ["q", "status", "tab", "workflow"],
  },
  {
    featureId: "agents.apps",
    load: () => import("@/features/agents/apps/AppPage").then((module) => module.AppPage),
    queryKeys: ["app", "q", "status", "tab"],
  },
  {
    featureId: "agents.skills",
    load: () => import("@/features/agents/skills/SkillPage").then((module) => module.SkillPage),
    queryKeys: ["q", "skill", "status", "tab"],
  },
]);

import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the gateway domain.
export const gatewayFeatureModules = defineFeatureModules([
  {
    featureId: "gateway.health",
    load: () => import("./health/GatewayHealthPage").then((module) => module.GatewayHealthPage),
    queryKeys: ["range"],
  },
  {
    featureId: "gateway.providers",
    load: () => import("./providers/ProviderPage").then((module) => module.ProviderPage),
    queryKeys: ["page", "provider", "q", "range", "status"],
  },
  {
    featureId: "gateway.models",
    load: () => import("./models/ModelPage").then((module) => module.ModelPage),
    queryKeys: ["model", "model_provider", "page", "provider", "q", "range", "source", "status", "tab"],
  },
  {
    featureId: "gateway.chat",
    load: () => import("./chat/ChatTestPage").then((module) => module.ChatTestPage),
    // Prompt and response text is deliberately absent: it never leaves screen state.
    queryKeys: ["tab"],
  },
  {
    featureId: "prompts.lab",
    load: () => import("./prompt-lab/PromptLabPage").then((module) => module.PromptLabPage),
    queryKeys: ["exp", "tab"],
  },
]);

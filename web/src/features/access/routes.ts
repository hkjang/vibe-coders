import { defineFeatureModules } from "@/features/feature-module";

// Screens owned by the access domain.
export const accessFeatureModules = defineFeatureModules([
  {
    featureId: "access.users",
    load: () => import("./users/UsersPage").then((module) => module.UsersPage),
    queryKeys: ["tab"],
  },
  {
    featureId: "me.home",
    load: () => import("./me/MePage").then((module) => module.MePage),
    queryKeys: ["tab"],
  },
  {
    featureId: "team.home",
    load: () => import("./team/TeamPage").then((module) => module.TeamPage),
    queryKeys: ["tab", "team"],
  },
]);

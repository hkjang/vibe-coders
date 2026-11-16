import { defineFeatureModules } from "@/features/feature-module";
import { teamTableQueryKeys } from "./team/team-table-keys";
import { meQueryKeys } from "./me/me-query-keys";
import { ipQueryKeys } from "./users/ip-query-keys";
import { accountQueryKeys } from "./users/account-query-keys";
import { registeredTeamQueryKeys } from "./users/registered-team-query-keys";

// Screens owned by the access domain.
export const accessFeatureModules = defineFeatureModules([
  {
    featureId: "access.users",
    load: () => import("./users/UsersPage").then((module) => module.UsersPage),
    subroutes: [
      { path: "accounts", load: () => import("./users/AccountsPage").then((module) => module.AccountsPage) },
      { path: "ips", load: () => import("./users/IpUsagePage").then((module) => module.IpUsagePage) },
    ],
    queryKeys: ["tab", "api_key_id", ...ipQueryKeys, ...accountQueryKeys, ...registeredTeamQueryKeys],
  },
  {
    featureId: "me.home",
    load: () => import("./me/MePage").then((module) => module.MePage),
    queryKeys: meQueryKeys,
  },
  {
    featureId: "team.home",
    load: () => import("./team/TeamPage").then((module) => module.TeamPage),
    queryKeys: ["tab", "team", "window", "report_status", ...teamTableQueryKeys],
  },
]);

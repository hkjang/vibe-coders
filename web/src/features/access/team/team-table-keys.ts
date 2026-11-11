export const teamTableIds = [
  "users",
  "models",
  "failures",
  "reports",
  "skills",
  "candidates",
  "keys",
  "members",
  "available",
  "requests",
  "tools",
  "starter_models",
  "starter_skills",
] as const;
export type TeamTableId = (typeof teamTableIds)[number];
export const teamTableQueryKeys = teamTableIds.flatMap((id) =>
  ["q", "page", "size", "sort", "direction"].map((key) => id + "_" + key),
);

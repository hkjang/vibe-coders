export const meTableIds = [
  "requests",
  "skills",
  "models",
  "model_guidance",
  "team_winners",
  "failures",
  "reports",
  "templates",
  "products",
  "login_sessions",
] as const;
export type MeTableId = (typeof meTableIds)[number];
export const meQueryKeys = [
  "tab",
  "receipt",
  "report_window",
  "limit",
  "request_status",
  "skill_kind",
  "connection_client",
  ...meTableIds.flatMap((id) => ["q", "page", "size", "sort", "direction"].map((key) => id + "_" + key)),
];

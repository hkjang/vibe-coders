/** validateSavedFilterParams() in internal/proxy/admin_collab.go accepts only these keys. */
export const savedViewParamKeys = [
  "window",
  "metric",
  "scale",
  "viewMode",
  "from",
  "to",
  "tz",
  "models",
  "endpoint",
] as const;

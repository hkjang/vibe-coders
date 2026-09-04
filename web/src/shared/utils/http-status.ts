export type HTTPStatusTone = "success" | "warning" | "danger" | "muted";

export function httpStatusTone(code: number): HTTPStatusTone {
  if (code >= 200 && code < 400) return "success";
  if (code >= 400 && code < 500) return "warning";
  if (code >= 500 && code < 600) return "danger";
  return "muted";
}

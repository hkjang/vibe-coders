export const appRequestRefPattern = /^req_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{21}$/u;

export function isAppRequestRef(value: unknown): value is string {
  return typeof value === "string" && appRequestRefPattern.test(value);
}

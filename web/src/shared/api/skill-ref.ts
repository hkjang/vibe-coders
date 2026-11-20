// Canonical, fixed-length keyed references issued by the authenticated skill API.
export const skillRefPattern = /^skl_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

export function isSkillRef(value: unknown): value is string {
  return typeof value === "string" && skillRefPattern.test(value);
}

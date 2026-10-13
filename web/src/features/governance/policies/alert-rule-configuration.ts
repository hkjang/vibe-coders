import type { AlertRule } from "@/shared/api/domains/governance";
import { fingerprint } from "./policy-editor-security";

/** UpdateAlertFireState changes only these two observation fields, not rule configuration. */
export function alertRuleConfiguration(row: AlertRule): string {
  return fingerprint(
    Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== "last_value" && key !== "last_fired_at"),
    ),
  );
}

import { migrationRegistry } from "@/config/migration-registry";
import { migrationStatusLabels, roleLabel } from "@/config/ui-labels";
import { normalizedBoolean } from "./settings-utils";

export const featureTitles = new Map(
  migrationRegistry.map((feature) => [feature.featureId as string, feature.title as string]),
);

export const statusTones: Record<string, "danger" | "info" | "muted" | "success" | "warning"> = {
  hidden: "muted",
  legacy: "muted",
  preview_read_only: "info",
  preview: "info",
  stable: "success",
  deprecated: "warning",
  retired: "danger",
};

export function statusDisplay(status: string): string {
  return Object.prototype.hasOwnProperty.call(migrationStatusLabels, status)
    ? migrationStatusLabels[status as keyof typeof migrationStatusLabels]
    : "확인 불가";
}

function roleCodes(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role !== "");
}

export function roleDisplay(value: string | undefined): React.JSX.Element {
  const roles = roleCodes(value);
  if (roles.length === 0) return <span>기능별 기본 역할 제한</span>;
  return (
    <span className="settings-key-cell">
      <span>{roles.map((role) => roleLabel(role)).join(", ")}</span>
      <small className="mono">{roles.join(", ")}</small>
    </span>
  );
}

export function readOnlyDisplay(value: string | undefined): React.JSX.Element {
  const normalized = normalizedBoolean(value ?? "false");
  return (
    <span className="settings-key-cell">
      <span>{normalized === "true" ? "쓰기 차단" : "쓰기 허용"}</span>
      <small className="mono">{normalized}</small>
    </span>
  );
}

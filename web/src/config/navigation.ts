import { migrationRegistry } from "@/config/migration-registry";

export const navigationGroups = Array.from(new Set(migrationRegistry.map((feature) => feature.group)));

export const statusLabels = {
  hidden: "Hidden",
  legacy: "Legacy",
  preview_read_only: "Read Only",
  preview: "Preview",
  stable: "Stable",
  deprecated: "Deprecated",
  retired: "Retired",
} as const;

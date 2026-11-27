import { failedId, unclassifiedId } from "@/features/insights/charts/palette";
import type { CategoryRef } from "@/shared/api/domains/insights-common";

// Category IDs are immutable dotted slugs: 대분류 `dev`, 중분류 `dev.codegen`,
// 소분류 `dev.codegen.api`. The drill-down path is therefore readable from the ID.

export const levelNames = ["대분류", "중분류", "소분류"] as const;

/** `dev.codegen.api` → [`dev`, `dev.codegen`, `dev.codegen.api`]; an empty ID has no path. */
export function categoryPath(id: string): string[] {
  if (!id) return [];
  const parts = id.split(".");
  return parts.map((_, index) => parts.slice(0, index + 1).join("."));
}

export function parentCategoryId(id: string): string {
  const dot = id.lastIndexOf(".");
  return dot < 0 ? "" : id.slice(0, dot);
}

/** 1 for a top-level category; 0 for no category. */
export function categoryLevel(id: string): number {
  return id ? id.split(".").length : 0;
}

/** The name of the level a breakdown under `parentId` lists (its children). */
export function childLevelName(parentId: string): string {
  return levelNames[Math.min(categoryLevel(parentId), levelNames.length - 1)] ?? "소분류";
}

export interface Crumb {
  /** "" is the root (all top-level categories). */
  id: string;
  label: string;
}

/**
 * Breadcrumb from the root to `parentId`. Names come from whatever category
 * references the screen has already loaded; an unknown step shows its own slug.
 */
export function breadcrumb(parentId: string, names: ReadonlyMap<string, string>): Crumb[] {
  return [
    { id: "", label: "전체 업무" },
    ...categoryPath(parentId).map((id) => ({ id, label: names.get(id) || (id.split(".").at(-1) ?? id) })),
  ];
}

/** Collects `id → name` from category references, later references winning. */
export function categoryNames(
  ...groups: readonly (readonly (CategoryRef | null | undefined)[] | undefined)[]
): Map<string, string> {
  const names = new Map<string, string>();
  for (const group of groups) {
    for (const ref of group ?? []) {
      if (ref?.id && ref.name) names.set(ref.id, ref.name);
    }
  }
  return names;
}

export type DrillTarget =
  | { kind: "children"; parent: string }
  | { kind: "sessions"; category: string }
  | { kind: "requests"; status: "unclassified" | "failed" };

/**
 * Where a click on a breakdown row leads: into its children while it has any,
 * otherwise to the sessions of that category. The synthetic unclassified and
 * failed rows lead to the matching requests.
 */
export function drillTarget(row: { id: string; hasChildren: boolean }): DrillTarget {
  if (row.id === unclassifiedId) return { kind: "requests", status: "unclassified" };
  if (row.id === failedId) return { kind: "requests", status: "failed" };
  return row.hasChildren ? { kind: "children", parent: row.id } : { kind: "sessions", category: row.id };
}

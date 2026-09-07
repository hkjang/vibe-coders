import type { ComponentType } from "react";

import type { FeatureId } from "@/config/migration-registry";

/**
 * One React screen registered for a migration feature. Domains export a list of
 * these from `src/features/<domain>/routes.ts`; `src/features/registry.ts` merges
 * them into the router and the URL query allowlist.
 */
export interface FeatureModule {
  readonly featureId: FeatureId;
  /** Lazy screen import: `() => import("./UsersPage").then((m) => m.UsersPage)`. */
  readonly load: () => Promise<ComponentType>;
  /**
   * Query parameter keys this screen (and its sub-paths) may carry in the URL.
   * Any other key is stripped by the route guard before the screen renders.
   * Never list keys that could carry credentials or prompt text.
   */
  readonly queryKeys?: readonly string[];
}

export function defineFeatureModules(modules: readonly FeatureModule[]): readonly FeatureModule[] {
  return modules;
}

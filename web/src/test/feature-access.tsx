import type { PropsWithChildren } from "react";

import { FeatureAccessContext } from "@/shared/feature-access/context";

/** Explicit ownership for isolated pilot tests; production gets this from FeatureRoute. */
export function FeatureAccessHarness({
  children,
  featureId,
  readOnly = false,
}: PropsWithChildren<{ featureId: string; readOnly?: boolean }>) {
  return (
    <FeatureAccessContext.Provider value={{ featureId, readOnly, permitted: true }}>
      {children}
    </FeatureAccessContext.Provider>
  );
}

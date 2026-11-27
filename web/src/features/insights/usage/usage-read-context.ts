import { createContext, useContext } from "react";

import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";

/**
 * One read lifetime for the whole screen: every panel's query is owned by the
 * signed-in principal that opened it and is dropped when that changes.
 */
export const UsageReadContext = createContext<FeatureReadOwner | undefined>(undefined);

export function useUsageOwner(): FeatureReadOwner {
  const owner = useContext(UsageReadContext);
  if (!owner) throw new Error("UsageReadContext is missing: render inside UsagePage");
  return owner;
}

import { createContext, useContext } from "react";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

export type ProviderReadOwner = FeatureReadOwner;
export const ProviderReadContext = createContext<ProviderReadOwner | undefined>(undefined);
export const providerOwnedKey = featureOwnedKey;
export const assertProviderRead = assertFeatureRead;
export function useProviderReadOwner(): ProviderReadOwner {
  return useFeatureReadOwner("gateway.providers", "provider-read-owner", ["routing:read"]);
}

/** Standalone dialogs also receive a local lifetime; page dialogs share their page owner. */
export function useProviderReadScope(): ProviderReadOwner {
  const inherited = useContext(ProviderReadContext);
  const local = useProviderReadOwner();
  return inherited ?? local;
}

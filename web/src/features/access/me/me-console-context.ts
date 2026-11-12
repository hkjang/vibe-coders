import { createContext, useContext } from "react";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
export const MeConsoleContext = createContext<FeatureReadOwner | null>(null);
export function useMeOwner() {
  const owner = useContext(MeConsoleContext);
  if (!owner) throw new Error("Personal console read boundary is missing");
  return owner;
}

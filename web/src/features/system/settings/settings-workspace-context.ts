import { createContext, useContext } from "react";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";

export interface SettingsWorkspace {
  owner: FeatureReadOwner;
  principal: string;
  scopedWriter: boolean;
  effectiveKey: readonly unknown[];
}
export const SettingsWorkspaceContext = createContext<SettingsWorkspace | undefined>(undefined);
export function useSettingsWorkspace(): SettingsWorkspace {
  const value = useContext(SettingsWorkspaceContext);
  if (!value) throw new Error("Settings workspace boundary is missing");
  return value;
}

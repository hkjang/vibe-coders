import type { PropsWithChildren } from "react";
import { SettingsWorkspaceContext } from "@/features/system/settings/settings-workspace-context";
import { systemSettingsKeys } from "@/features/system/settings/use-system-settings";
import { featureOwnedKey, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
const settingsTestOwner: FeatureReadOwner = {
  id: 1,
  marker: "isolated-settings-test",
  readable: true,
  denied: false,
  isCurrent: () => true,
  restart: () => undefined,
};
export function SettingsWorkspaceHarness({ children }: PropsWithChildren) {
  return (
    <SettingsWorkspaceContext.Provider
      value={{
        owner: settingsTestOwner,
        principal: "isolated-settings",
        scopedWriter: false,
        effectiveKey: featureOwnedKey(systemSettingsKeys.effective, settingsTestOwner),
      }}
    >
      {children}
    </SettingsWorkspaceContext.Provider>
  );
}

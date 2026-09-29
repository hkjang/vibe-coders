import { createContext, useContext } from "react";

import type { UnsavedChangesCoordinator } from "@/shared/unsaved/coordinator";

export const UnsavedChangesContext = createContext<UnsavedChangesCoordinator | undefined>(undefined);

export function useUnsavedChanges(): UnsavedChangesCoordinator | undefined {
  return useContext(UnsavedChangesContext);
}

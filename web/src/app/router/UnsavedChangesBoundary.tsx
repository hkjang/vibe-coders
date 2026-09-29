import { Outlet } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

export function UnsavedChangesBoundary(): React.JSX.Element {
  const auth = useAuth();
  const enabled = auth.uiEnabled && ["authenticated", "legacy", "open"].includes(auth.mode);
  return (
    <UnsavedChangesProvider enabled={enabled} blockNavigation>
      <Outlet />
    </UnsavedChangesProvider>
  );
}

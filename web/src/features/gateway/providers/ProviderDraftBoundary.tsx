import type { PropsWithChildren } from "react";

import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

/** Production uses the shell's single blocker; standalone screens retain close/unload guards. */
export function ProviderDraftBoundary({ children }: PropsWithChildren): React.JSX.Element {
  const coordinator = useUnsavedChanges();
  return coordinator ? <>{children}</> : <UnsavedChangesProvider>{children}</UnsavedChangesProvider>;
}

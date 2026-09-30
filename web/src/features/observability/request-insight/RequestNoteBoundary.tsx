import { useContext, type ReactNode } from "react";

import { RequestNoteContext } from "./request-note-context";
import { useRequestNoteEditor } from "./use-request-note-editor";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

export function RequestNoteBoundary({ children }: { children: ReactNode }): React.JSX.Element {
  const inherited = useContext(RequestNoteContext);
  const coordinator = useUnsavedChanges();
  if (inherited) return <>{children}</>;
  return coordinator ? (
    <RequestNoteOwner>{children}</RequestNoteOwner>
  ) : (
    <UnsavedChangesProvider>
      <RequestNoteOwner>{children}</RequestNoteOwner>
    </UnsavedChangesProvider>
  );
}
function RequestNoteOwner({ children }: { children: ReactNode }): React.JSX.Element {
  const editor = useRequestNoteEditor();
  return <RequestNoteContext.Provider value={editor}>{children}</RequestNoteContext.Provider>;
}

import { useContext, type ReactNode } from "react";

import { RequestNoteContext } from "./request-note-context";
import { useRequestNoteEditor, type RequestNoteRetention } from "./use-request-note-editor";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

export function RequestNoteBoundary({
  children,
  retainDraft,
}: {
  children: ReactNode;
  retainDraft?: RequestNoteRetention;
}): React.JSX.Element {
  const inherited = useContext(RequestNoteContext);
  const coordinator = useUnsavedChanges();
  if (inherited) return <>{children}</>;
  return coordinator ? (
    <RequestNoteOwner retainDraft={retainDraft}>{children}</RequestNoteOwner>
  ) : (
    <UnsavedChangesProvider>
      <RequestNoteOwner retainDraft={retainDraft}>{children}</RequestNoteOwner>
    </UnsavedChangesProvider>
  );
}
function RequestNoteOwner({
  children,
  retainDraft,
}: {
  children: ReactNode;
  retainDraft?: RequestNoteRetention;
}): React.JSX.Element {
  const editor = useRequestNoteEditor(retainDraft);
  return <RequestNoteContext.Provider value={editor}>{children}</RequestNoteContext.Provider>;
}

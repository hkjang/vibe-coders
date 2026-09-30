import { createContext, useContext } from "react";

import type { RequestNoteEditor } from "./use-request-note-editor";

export const RequestNoteContext = createContext<RequestNoteEditor | undefined>(undefined);
export function useRequestNoteContext(): RequestNoteEditor {
  const editor = useContext(RequestNoteContext);
  if (!editor) throw new Error("Request notes require a note boundary");
  return editor;
}

import { z } from "zod";

import { versionAtLeast } from "@/config/migration-registry";
import type { RequestNoteBody } from "@/shared/api/domains/observability";
import { requestNoteSchema, type RequestNote } from "@/shared/api/domains/observability.schemas";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";

export const requestNoteKey = (id: string, epoch: number) =>
  ["observability", "requests", id, "note", epoch] as const;
export const requestNoteContractMessage =
  "메모·태그를 안전하게 편집하려면 백엔드 v0.86.16 이상이 필요합니다. 서버 버전을 확인하거나 업그레이드하세요.";
export const supportsRequestNoteContract = (version: unknown): boolean =>
  typeof version === "string" && versionAtLeast(version, "v0.86.16");

interface QueryState {
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  isInvalidated?: boolean;
  data?: unknown;
}
export function confirmedRequestNote(state: QueryState | undefined, id: string): RequestNote | undefined {
  if (!state || state.status !== "success" || state.fetchStatus !== "idle" || state.isInvalidated)
    return undefined;
  const parsed = requestNoteSchema.safeParse(state.data);
  if (!parsed.success || parsed.data.request_id !== id) return undefined;
  return parsed.data;
}

const mode = z.enum(["preserve", "replace", "clear"]);
const goWhitespaceOnly = /^\p{White_Space}*$/u;
function replacementTags(input: string): string[] {
  return input
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function hasStoredTagValue(input: string): boolean {
  // Check emptiness only: Go cleanTags removes exactly one leading #, then
  // strings.TrimSpace (Unicode White_Space, including NEL but not FEFF).
  // Keep the existing outbound tags untouched; server normalization owns the
  // stored values, and preserved fields never pass through this predicate.
  return replacementTags(input).some(
    (tag) => !goWhitespaceOnly.test(tag.startsWith("#") ? tag.slice(1) : tag),
  );
}

export const requestNoteFormSchema = z
  .object({ noteMode: mode, tagsMode: mode, note: z.string(), tags: z.string() })
  .superRefine((values, context) => {
    for (const field of ["note", "tags"] as const) {
      if (values[`${field}Mode`] !== "replace") continue;
      const value = values[field].trim();
      const label = field === "note" ? "메모" : "태그";
      if (!value || (field === "tags" ? !hasStoredTagValue(values.tags) : goWhitespaceOnly.test(value)))
        context.addIssue({
          code: "custom",
          path: [field],
          message: `새 ${label}를 입력하거나 ‘비우기’를 선택하세요.`,
        });
      if (value.length > (field === "note" ? 2000 : 200))
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${label}는 ${field === "note" ? 2000 : 200}자까지 입력할 수 있습니다.`,
        });
      if (field === "note" && containsPotentialSecret(value))
        context.addIssue({ code: "custom", path: [field], message: secretSearchMessage });
    }
  });
export type RequestNoteValues = z.infer<typeof requestNoteFormSchema>;
export function requestNoteDefaults(note: RequestNote): RequestNoteValues {
  return {
    noteMode: "preserve",
    tagsMode: "preserve",
    note: note.redacted_fields.includes("note") ? "" : note.note,
    tags: note.redacted_fields.includes("tags") ? "" : note.tags.join(", "),
  };
}
export function requestNoteBody(values: RequestNoteValues): RequestNoteBody {
  const parsed = requestNoteFormSchema.parse(values);
  const preserve_fields: ("note" | "tags")[] = [];
  const body: RequestNoteBody = { preserve_fields };
  if (parsed.noteMode === "preserve") preserve_fields.push("note");
  else body.note = parsed.noteMode === "clear" ? "" : parsed.note.trim();
  if (parsed.tagsMode === "preserve") preserve_fields.push("tags");
  else body.tags = Object.freeze(parsed.tagsMode === "clear" ? [] : replacementTags(parsed.tags));
  Object.freeze(preserve_fields);
  return Object.freeze(body);
}

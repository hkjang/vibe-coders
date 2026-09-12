import { containsPotentialSecret } from "@/shared/security/secrets";

/**
 * A palette entry. The pattern this screen follows offers three kinds of entry from one
 * keyboard surface — destinations, commands, and the records you were just looking at —
 * so an operator does not have to remember which menu holds which action.
 */
export type CommandKind = "action" | "feature" | "jump" | "recent";

export interface CommandItem {
  id: string;
  kind: CommandKind;
  title: string;
  /** Group name, shortcut hint or the current value of a setting. */
  hint?: string;
  /** Words that should match this entry even when they are not in the title. */
  keywords?: readonly string[];
  run: () => void;
}

/** The id shapes the request explorer can filter on, in the order we offer them. */
const jumpFields = [
  { field: "request_id", label: "요청 ID로 이동" },
  { field: "trace_id", label: "추적 ID로 이동" },
  { field: "session_id", label: "세션 ID로 이동" },
] as const;

/**
 * A pasted identifier is worth offering as a jump; a pasted credential is not. The same
 * guard the filter form uses keeps a key out of the URL, because the jump writes the
 * value into a query string.
 */
export function jumpCandidate(query: string): string | undefined {
  const value = query.trim();
  if (value.length < 6 || value.length > 512) return undefined;
  if (/\s/.test(value)) return undefined;
  if (containsPotentialSecret(value)) return undefined;
  // An identifier, not a sentence or a path fragment someone is searching for.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return undefined;
  return value;
}

export function jumpItems(query: string, go: (path: string) => void): CommandItem[] {
  const value = jumpCandidate(query);
  if (value === undefined) return [];
  return jumpFields.map(({ field, label }) => ({
    id: `jump:${field}`,
    kind: "jump" as const,
    title: label,
    hint: value,
    run: () => go(`/observability/requests?${field}=${encodeURIComponent(value)}`),
  }));
}

export function matchesQuery(item: CommandItem, needle: string): boolean {
  if (needle === "") return true;
  return [item.title, item.hint ?? "", ...(item.keywords ?? [])]
    .join(" ")
    .toLocaleLowerCase("ko-KR")
    .includes(needle);
}

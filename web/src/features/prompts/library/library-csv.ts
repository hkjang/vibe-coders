import { containsPotentialSecret } from "@/shared/security/secrets";
import { toCsv } from "@/shared/utils/csv";
import { hiddenLibraryText, libraryError } from "./library-model";

export const libraryCsvHeaders = [
  "created_at",
  "trace_id",
  "request_id",
  "endpoint",
  "provider",
  "model",
  "api_key_id",
  "client_ip",
  "status_code",
  "first_chunk_ms",
  "latency_ms",
  "prompt_tokens",
  "completion_tokens",
  "cached_tokens",
  "reasoning_tokens",
  "total_tokens",
  "cost_krw",
  "token_source",
  "stream",
  "languages",
  "error",
] as const;

/** Accept only the existing CSV contract, including quoted commas and newlines. */
export function projectLibraryCsv(source: string, prefixes: readonly string[]): string {
  if (source.length > 32 * 1024 * 1024) throw libraryError();
  const text = source.replace(/^\uFEFF/u, "");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const field = () => {
    row.push(cell);
    cell = "";
    closed = false;
  };
  const record = () => {
    field();
    rows.push(row);
    row = [];
    if (rows.length > 10001) throw libraryError();
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === ",") field();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record();
    } else if (closed) throw libraryError();
    else if (char === '"') {
      if (cell) throw libraryError();
      quoted = true;
    } else cell += char;
  }
  if (quoted) throw libraryError();
  if (cell || closed || row.length) record();
  if (
    JSON.stringify(rows.shift()) !== JSON.stringify(libraryCsvHeaders) ||
    rows.some((item) => item.length !== libraryCsvHeaders.length)
  )
    throw libraryError();
  const masked = rows.map((item) =>
    item.map((value) => (containsPotentialSecret(value, prefixes) ? hiddenLibraryText : value)),
  );
  return toCsv(
    masked,
    libraryCsvHeaders.map((header, index) => ({ header, value: (item: string[]) => item[index] })),
  );
}

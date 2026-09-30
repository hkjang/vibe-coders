import type { RoutingPreview } from "@/shared/api/domains/routing";
import { containsPotentialSecret } from "@/shared/security/secrets";

export interface PreviewDraft {
  model: string;
  apiKeyId: string;
  sample: string;
}
export interface PreviewSnapshot {
  readonly draft: Readonly<PreviewDraft>;
  readonly body: {
    model: string;
    messages: Array<{ role: "user"; content: string }>;
    api_key_id?: string;
  };
}
export type PreviewState =
  | { kind: "idle" }
  | { kind: "pending"; snapshot: PreviewSnapshot }
  | { kind: "success"; snapshot: PreviewSnapshot; result: RoutingPreview }
  | { kind: "error"; snapshot: PreviewSnapshot; message: string; requestId?: string };

export const emptyPreviewDraft: PreviewDraft = { model: "", apiKeyId: "", sample: "" };
export const hiddenPreviewValue = "민감정보가 포함될 수 있어 표시하지 않습니다.";

export function previewSnapshot(
  draft: PreviewDraft,
  prefixes: readonly string[],
): PreviewSnapshot | undefined {
  if (!draft.model.trim() || containsPotentialSecret(draft.apiKeyId, prefixes)) return undefined;
  // Preserve the existing wire contract: trim model/key ID, not the sample.
  const body: PreviewSnapshot["body"] = {
    model: draft.model.trim(),
    messages: [{ role: "user", content: draft.sample }],
  };
  if (draft.apiKeyId.trim()) body.api_key_id = draft.apiKeyId.trim();
  return { draft: { ...draft }, body };
}

export function previewDraftChanged(draft: PreviewDraft, snapshot: PreviewSnapshot): boolean {
  return (
    draft.model !== snapshot.draft.model ||
    draft.apiKeyId !== snapshot.draft.apiKeyId ||
    draft.sample !== snapshot.draft.sample
  );
}

export function previewText(value: string | undefined, prefixes: readonly string[], empty = "—"): string {
  return value && containsPotentialSecret(value, prefixes) ? hiddenPreviewValue : value || empty;
}

export function previewTier(value: string | undefined, prefixes: readonly string[]): string {
  if (value && containsPotentialSecret(value, prefixes)) return hiddenPreviewValue;
  switch (value) {
    case "simple":
      return "단순";
    case "standard":
      return "일반";
    case "complex":
      return "복잡";
    case "reasoning":
      return "추론";
    case "low":
      return "낮음";
    case "medium":
      return "중간";
    case "high":
      return "높음";
    case "critical":
      return "매우 높음";
    default:
      return value || "—";
  }
}

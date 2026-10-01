import type { ImportPolicy, ImportRule, PolicyImportBody } from "@/shared/api/domains/policy-import";
import { validatePolicyDocument } from "@/shared/api/domains/policy-import";
import {
  decodePolicyBytes,
  ExactPolicyNumber,
  importProblem,
  parsePolicyJSON,
  policyFingerprint,
  policyImportLimits,
  PolicyImportProblem,
} from "@/shared/api/domains/policy-import-json";
import { editorText, protectedJson, protectedText } from "./policy-editor-security";

export interface ImportSelection {
  body: PolicyImportBody;
  bytes: ArrayBuffer;
  name: string;
  identity: object;
}
export function parseImportFile(bytes: ArrayBuffer, name: string): ImportSelection {
  if (bytes.byteLength > policyImportLimits.bytes) return importProblem("파일은 4 MiB 이하로 선택하세요.");
  const body = validatePolicyDocument(parsePolicyJSON(decodePolicyBytes(bytes)));
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > policyImportLimits.bytes)
    return importProblem("전송할 JSON이 4 MiB를 초과합니다.");
  return { body, bytes, name, identity: {} };
}
export function parseCurrentExport(bytes: ArrayBuffer): PolicyImportBody {
  return validatePolicyDocument(parsePolicyJSON(decodePolicyBytes(bytes), true), true);
}
export function samePolicies(left: PolicyImportBody, right: PolicyImportBody): boolean {
  const sorted = (value: PolicyImportBody) =>
    [...value.policies].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return policyFingerprint(sorted(left)) === policyFingerprint(sorted(right));
}
const numeric = (value: unknown) => (typeof value === "number" ? value : 0);
export function effectiveRule(rule: ImportRule, parent: string): ImportRule {
  const stored = { ...rule };
  delete stored.rollout_percent;
  delete stored.updated_at;
  return {
    ...stored,
    policy_id: rule.policy_id || parent,
    name: rule.name ?? "",
    enabled: rule.enabled ?? false,
    priority: numeric(rule.priority) || 100,
    conditions: rule.conditions ?? {},
    actions: rule.actions ?? {},
  };
}
export function effectivePolicy(policy: ImportPolicy, before?: ImportPolicy): ImportPolicy {
  const rollout = numeric(policy.rollout_percent);
  return {
    ...policy,
    description: policy.description ?? "",
    enabled: policy.enabled ?? false,
    priority: numeric(policy.priority) || 100,
    rollout_percent: rollout <= 0 || rollout > 100 ? 100 : rollout,
    rules:
      policy.rules == null
        ? (before?.rules ?? [])
        : policy.rules.map((rule) => effectiveRule(rule, policy.id)),
  };
}
export function importImpacts(body: PolicyImportBody, baseline: PolicyImportBody) {
  const previous = new Map(baseline.policies.map((policy) => [policy.id, policy]));
  return body.policies.map((policy) => {
    const before = previous.get(policy.id);
    const after = effectivePolicy(policy, before);
    const newIds = new Set(after.rules?.map((rule) => rule.id));
    return {
      before,
      after,
      input: policy,
      activates: after.enabled === true,
      removed: (before?.rules ?? []).filter((rule) => !newIds.has(rule.id)).length,
      mode:
        policy.rules == null ? "기존 규칙 유지" : policy.rules.length ? "규칙 전체 교체" : "모든 규칙 제거",
    };
  });
}
export function importDisplay(value: unknown, prefixes: readonly string[]): string {
  if (protectedJson(value, prefixes)) return protectedText;
  if (value instanceof ExactPolicyNumber) return value.token;
  if (value === undefined) return "없음";
  if (typeof value === "string") return editorText(value, prefixes);
  // Exact-number tokens from the baseline are only displayed, never sent as objects.
  const render = (item: unknown): string => {
    if (item instanceof ExactPolicyNumber) return item.token;
    if (Array.isArray(item)) return `[${item.map(render).join(", ")}]`;
    if (item && typeof item === "object")
      return `{${Object.entries(item)
        .map(([key, entry]) => `${JSON.stringify(key)}: ${render(entry)}`)
        .join(", ")}}`;
    return JSON.stringify(item) ?? "없음";
  };
  return render(value);
}
export function readImportFile(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
  if (file.size > policyImportLimits.bytes)
    return Promise.reject(new PolicyImportProblem("파일은 4 MiB 이하로 선택하세요."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const finish = () => signal.removeEventListener("abort", abort);
    reader.onload = () => {
      finish();
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("파일을 읽지 못했습니다."));
    };
    reader.onerror = () => {
      finish();
      reject(new Error("파일을 읽지 못했습니다."));
    };
    reader.onabort = () => {
      finish();
      reject(new Error("이전 파일 읽기입니다."));
    };
    if (signal.aborted) {
      reject(new Error("이전 파일 읽기입니다."));
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    reader.readAsArrayBuffer(file);
  });
}
export function downloadPolicyBytes(bytes: ArrayBuffer, assertCurrent: () => void) {
  assertCurrent();
  const revoke = URL.revokeObjectURL.bind(URL);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/json;charset=utf-8" }));
  try {
    assertCurrent();
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "policy-backup.json";
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  } finally {
    window.setTimeout(() => revoke(url), 1000);
  }
}

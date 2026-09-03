import { containsPotentialSecret } from "@/shared/security/secrets";

export const providerRefPattern = /^prv_[A-Za-z0-9_-]{43}$/;

export function isProviderRef(value: unknown): value is string {
  return typeof value === "string" && providerRefPattern.test(value);
}

export function isSafeLegacyProviderName(value: string): boolean {
  if (
    value === "" ||
    value === "[provider-name-omitted]" ||
    value.trim() !== value ||
    value.includes(",") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    }) ||
    containsPotentialSecret(value)
  ) {
    return false;
  }
  return value.length <= 256 && new TextEncoder().encode(value).byteLength <= 256;
}

export function providerDisplayLabel(name: string, providerRef: string, disambiguate = false): string {
  const safeName = isSafeLegacyProviderName(name) ? name : "공급자 이름 비공개";
  if (!disambiguate && safeName === name) return safeName;
  return `${safeName} · ${providerRef.slice(-8)}`;
}

export function providerDisplayLabels(
  items: ReadonlyArray<{ name: string; providerRef: string }>,
): Map<string, string> {
  const namesByRef = new Map<string, string>();
  for (const item of items) {
    const existing = namesByRef.get(item.providerRef);
    namesByRef.set(
      item.providerRef,
      existing && existing !== item.name ? "[provider-name-omitted]" : item.name,
    );
  }
  const groups = new Map<string, Array<{ name: string; providerRef: string }>>();
  for (const [providerRef, name] of namesByRef) {
    const baseName = isSafeLegacyProviderName(name) ? name : "공급자 이름 비공개";
    const group = groups.get(baseName) ?? [];
    group.push({ name, providerRef });
    groups.set(baseName, group);
  }

  const labels = new Map<string, string>();
  for (const [baseName, group] of groups) {
    const sorted = group.sort((left, right) => left.providerRef.localeCompare(right.providerRef));
    for (const [index, item] of sorted.entries()) {
      if (sorted.length === 1 && isSafeLegacyProviderName(item.name)) {
        labels.set(item.providerRef, baseName);
      } else {
        labels.set(
          item.providerRef,
          `${baseName} · ${String(index + 1).padStart(2, "0")} · ${item.providerRef.slice(-8)}`,
        );
      }
    }
  }
  return labels;
}

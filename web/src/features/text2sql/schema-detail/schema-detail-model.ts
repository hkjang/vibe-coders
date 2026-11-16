import { containsPotentialSecret } from "@/shared/security/secrets";

export function validSchemaDetailName(name: string, prefixes: readonly string[]): boolean {
  return (
    Boolean(name) &&
    name.trim() === name &&
    [...name].length <= 512 &&
    new TextEncoder().encode(name).length <= 2048 &&
    !/\p{C}/u.test(name) &&
    !containsPotentialSecret(name, prefixes)
  );
}
export function schemaDetailText(text: string, prefixes: readonly string[], empty = "—"): string {
  return !text ? empty : containsPotentialSecret(text, prefixes) ? "비공개 정보" : text;
}

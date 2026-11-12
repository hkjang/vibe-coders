import { containsPotentialSecret } from "@/shared/security/secrets";

export function validAccountId(value: string, prefixes: readonly string[]): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 4096 &&
    !/\p{C}/u.test(value) &&
    !containsPotentialSecret(value, prefixes)
  );
}

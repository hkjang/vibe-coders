import { containsPotentialSecret } from "@/shared/security/secrets";

/** Display protection only; the server projection and its privacy boundary remain independent. */
export function flowDisplay(value: string, prefixes: readonly string[]): string {
  return containsPotentialSecret(value, prefixes) ? "[값 비공개]" : value;
}

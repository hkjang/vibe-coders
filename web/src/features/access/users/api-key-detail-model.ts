import { containsPotentialSecret } from "@/shared/security/secrets";

export function validAPIKeyDetailId(value: string, prefixes: readonly string[]): boolean {
  return /^[A-Za-z0-9._:-]{1,512}$/u.test(value) && !containsPotentialSecret(value, prefixes);
}

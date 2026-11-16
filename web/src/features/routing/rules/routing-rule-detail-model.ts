import { containsPotentialSecret } from "@/shared/security/secrets";
export function validRoutingRuleDetailId(value: string, prefixes: readonly string[]) {
  return (
    !!value &&
    [...value].length <= 512 &&
    value.trim() === value &&
    !/\p{C}/u.test(value) &&
    !containsPotentialSecret(value, prefixes)
  );
}

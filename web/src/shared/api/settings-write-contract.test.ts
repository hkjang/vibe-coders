import { expect, expectTypeOf, it } from "vitest";

import type { KeycloakConfigRequestWritable } from "@/shared/api/generated";

type RequiredKeys<Value> = {
  [Key in keyof Value]-?: object extends Pick<Value, Key> ? never : Key;
}[keyof Value];

it("requires every SSO replacement field while preserving explicit omission semantics", () => {
  expectTypeOf<RequiredKeys<KeycloakConfigRequestWritable>>().toEqualTypeOf<
    | "enabled"
    | "issuer_url"
    | "client_id"
    | "redirect_uri"
    | "scopes"
    | "default_role"
    | "role_claim"
    | "group_claim"
    | "allow_local_login"
    | "auto_login"
  >();
  // @ts-expect-error Partial input must not advertise a safe partial update.
  const partial: KeycloakConfigRequestWritable = { allow_local_login: false };
  expect(partial.allow_local_login).toBe(false);
});

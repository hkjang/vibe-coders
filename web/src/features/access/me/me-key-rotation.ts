import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";

export function canRotateMeKey(key: ApiKeyPublic): boolean {
  return (
    key.status === "active" &&
    !key.revoked_at &&
    !key.replaced_by &&
    /^[a-f0-9]{64}$/u.test(key.revision) &&
    (!key.expires_at || Date.parse(key.expires_at) > Date.now())
  );
}

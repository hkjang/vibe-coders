import { containsPotentialSecret } from "@/shared/security/secrets";
import { useContext } from "react";
import { ApiKeyDetailFocusContext } from "./api-key-detail-focus";
import { Link, useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { validAPIKeyDetailId } from "./api-key-detail-model";

export function ApiKeyDetailLink({ row }: { row: ApiKeyPublic }) {
  const auth = useAuth();
  const returnFocusRef = useContext(ApiKeyDetailFocusContext);
  const location = useLocation();
  const name = containsPotentialSecret(row.name, auth.credentialPrefixes)
    ? "보호된 키 이름"
    : row.name || "이름 없음";
  if (
    !versionAtLeast(auth.backendVersion, "v0.86.101") ||
    !validAPIKeyDetailId(row.id, auth.credentialPrefixes)
  )
    return <strong className="truncate">{name}</strong>;
  const params = new URLSearchParams(location.search);
  params.set("tab", "keys");
  params.set("api_key_id", row.id);
  return (
    <Link
      onClick={(event) => {
        if (returnFocusRef) returnFocusRef.current = event.currentTarget;
      }}
      className="access-text-link"
      to={{ pathname: location.pathname, search: params.toString() }}
    >
      {name}
    </Link>
  );
}

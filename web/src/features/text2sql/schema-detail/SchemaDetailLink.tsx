import { Link } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { schemaDetailText, validSchemaDetailName } from "./schema-detail-model";

export function SchemaDetailLink({ name }: { name: string }) {
  const auth = useAuth();
  const label = schemaDetailText(name, auth.credentialPrefixes);
  if (
    !versionAtLeast(auth.backendVersion, "v0.86.107") ||
    !validSchemaDetailName(name, auth.credentialPrefixes) ||
    (auth.mode === "authenticated" && !auth.user?.scopes.includes("admin:read"))
  )
    return <strong>{label}</strong>;
  return <Link to={`/text2sql/schemas/detail?${new URLSearchParams({ schema_name: name })}`}>{label}</Link>;
}

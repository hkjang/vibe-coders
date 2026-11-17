import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { LegacySessionPage } from "./LegacySessionPage";
import { PagedSessionPage } from "./PagedSessionPage";
export function SessionPage() {
  const auth = useAuth();
  return auth.backendVersion && versionAtLeast(auth.backendVersion, "v0.86.153") ? (
    <PagedSessionPage />
  ) : (
    <LegacySessionPage />
  );
}

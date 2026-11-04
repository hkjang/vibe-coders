import { useAuth } from "@/app/auth/AuthProvider";
import { PoliciesLayout } from "./PoliciesLayout";
import { PolicyAdvisorTab } from "./PolicyAdvisorTab";

export function PolicyAdvisorPage() {
  const auth = useAuth();
  const canWrite = auth.user?.scopes.includes("admin:write") ?? false;
  return (
    <PoliciesLayout tab="advisor" canWrite={canWrite}>
      <PolicyAdvisorTab canWrite={canWrite} />
    </PoliciesLayout>
  );
}

import { useAuth } from "@/app/auth/AuthProvider";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

export const providerWriteDeniedReason = "공급자 변경은 admin:write 권한이 필요합니다.";

export function useProviderWriteAccess() {
  const auth = useAuth();
  return useFeatureMutationAccess(
    ["gateway.providers"],
    auth.user?.scopes.includes("admin:write") ?? false,
    providerWriteDeniedReason,
  );
}

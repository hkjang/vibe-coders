import { useAuth } from "@/app/auth/AuthProvider";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

export function useHealthWriteAccess() {
  const auth = useAuth();
  return useFeatureMutationAccess(
    ["gateway.health"],
    auth.user?.scopes.includes("routing:write") ?? false,
    "회로 차단기와 세션 고정 해제는 routing:write 권한이 필요합니다.",
  );
}

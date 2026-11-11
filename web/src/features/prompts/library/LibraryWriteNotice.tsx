import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useLibraryAccess } from "./use-library-mutation";

export function LibraryWriteNotice({ uncertain = false }: { uncertain?: boolean }) {
  const access = useLibraryAccess();
  if (uncertain)
    return (
      <InlineNotice tone="warning" title="이전 작업 결과 확인 필요">
        저장 여부를 확인하지 못해 다시 제출하지 않습니다. 목록과 변경 이력을 조회해 처리 결과를 확인하세요.
      </InlineNotice>
    );
  if (!access.allowed)
    return (
      <InlineNotice tone="info" title="읽기 전용으로 전환됐습니다.">
        {access.reason} 입력한 초안은 유지됩니다.
      </InlineNotice>
    );
  return null;
}

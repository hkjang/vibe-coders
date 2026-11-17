import type { ReactNode } from "react";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";

export function SettingsRecordBoundary({
  marker,
  children,
}: {
  marker: string;
  children: (owner: FeatureReadOwner) => ReactNode;
}): React.JSX.Element {
  const owner = useFeatureReadOwner("system.settings", marker);
  if (!owner.readable || owner.denied)
    return (
      <InlineNotice
        tone="danger"
        title="기록 조회 권한 확인 필요"
        actions={owner.readable ? <Button onClick={owner.restart}>권한 확인 후 다시 조회</Button> : undefined}
      >
        이전 기록과 변경 확인을 닫았습니다. 관리자에게 시스템 설정 조회 권한과 접근 조건을 확인해 달라고
        요청하세요.
      </InlineNotice>
    );
  return <div key={owner.id}>{children(owner)}</div>;
}

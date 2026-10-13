import { keyLifecycle } from "../key-lifecycle";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";

export function ApiKeySummary({
  rows,
  now,
}: {
  rows: readonly ApiKeyPublic[];
  now: number;
}): React.JSX.Element {
  const states = rows.map((row) => keyLifecycle(row, now));
  const expired = states.filter((state) => state.state === "expired" || state.state === "grace-ended").length;
  const usable = states.filter((state) => state.usable).length;
  return (
    <StatGrid label="API 키 요약">
      <StatCard label="전체 키" value={rows.length} />
      <StatCard label="사용 가능" value={usable} hint="교체 유예 중인 키 포함" />
      <StatCard label="만료·유예 종료" value={expired} />
      <StatCard
        label="기타 사용 불가"
        value={rows.length - usable - expired}
        hint="중지·폐기·시각 확인 필요"
      />
    </StatGrid>
  );
}

import { Download } from "lucide-react";
import { useId, useState } from "react";
import type { FlightRecorderEvent } from "@/shared/api/domains/observability.schemas";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { downloadCsv } from "@/shared/utils/csv";
import { formatNumber } from "@/shared/utils/format";
import { flightRecorderCsv, flightRecorderDescription } from "./flight-recorder-state";
import {
  defaultFlightEventFilters,
  flightEventKinds,
  flightEventOrders,
  flightEventSignals,
  selectFlightEvents,
  type FlightEventFilters,
} from "./flight-event-filters";
import { FlightRecorderEvents } from "./FlightRecorderEvents";

export function FlightRecorderTimeline({
  events,
  startedAt,
  sessionId,
  ready,
  canExport,
}: {
  events: readonly FlightRecorderEvent[];
  startedAt: number;
  sessionId: string;
  ready: boolean;
  canExport: () => boolean;
}): React.JSX.Element {
  const [filters, setFilters] = useState<FlightEventFilters>(defaultFlightEventFilters);
  const hintId = useId();
  const rows = selectFlightEvents(events, filters);
  const reset = () => setFilters(defaultFlightEventFilters);
  return (
    <SectionCard
      headingLevel={3}
      title="시간순 기록"
      description={flightRecorderDescription}
      actions={
        <Button
          size="small"
          disabled={rows.length === 0}
          aria-disabled={!ready || rows.length === 0}
          onClick={() => {
            if (!canExport() || rows.length === 0) return;
            downloadCsv(
              `flight-recorder-${sessionId || "session"}.csv`,
              flightRecorderCsv(rows.map((row) => row.event)),
            );
          }}
        >
          <Download aria-hidden="true" /> CSV 내보내기
        </Button>
      }
    >
      <fieldset className="flight-event-filters" aria-describedby={hintId}>
        <legend>수신 기록 좁혀 보기</legend>
        <label>
          요청 유형
          <Select
            value={filters.kind}
            options={flightEventKinds}
            onChange={(event) => {
              const option = flightEventKinds.find((item) => item.value === event.currentTarget.value);
              if (option) setFilters({ ...filters, kind: option.value });
            }}
          />
        </label>
        <label>
          기록 조건
          <Select
            value={filters.signal}
            options={flightEventSignals}
            onChange={(event) => {
              const option = flightEventSignals.find((item) => item.value === event.currentTarget.value);
              if (option) setFilters({ ...filters, signal: option.value });
            }}
          />
        </label>
        <label>
          표시 순서
          <Select
            value={filters.order}
            options={flightEventOrders}
            onChange={(event) => {
              const option = flightEventOrders.find((item) => item.value === event.currentTarget.value);
              if (option) setFilters({ ...filters, order: option.value });
            }}
          />
        </label>
        <Button size="small" onClick={reset}>
          기록 조건 초기화
        </Button>
      </fieldset>
      <p id={hintId}>
        유형과 조건을 함께 적용합니다. 위험 신호는 비밀정보 탐지·정책 차단·높은 코드 위험입니다. 오류와 위험은
        같은 기록에 함께 나타날 수 있습니다.
      </p>
      <p role="status" aria-label="세션 기록 표시 범위">
        수신 {formatNumber(events.length)}건 중 {formatNumber(rows.length)}건 표시 · CSV도 현재 표시 범위와
        순서로 내보냅니다.
      </p>
      <p>
        위 집계와 서버 요약은 필터 적용 전 수신 기록 기준입니다. 상대 위치는 첫 기록 시각과의 차이이며 실제
        실행 시작·종료를 뜻하지 않습니다.
      </p>
      {events.length === 0 ? (
        <EmptyState
          title="이 응답에서 확인할 기록이 없습니다."
          description="세션 전체의 요청 존재 여부나 기록의 완전성을 판단할 수 없습니다."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="조건에 맞는 수신 기록이 없습니다."
          description="이 세션 전체에 기록이 없다는 뜻은 아닙니다. 기록 조건을 초기화해 수신한 항목을 확인하세요."
          actions={<Button onClick={reset}>모든 수신 기록 보기</Button>}
        />
      ) : (
        <FlightRecorderEvents entries={rows} startedAt={startedAt} />
      )}
    </SectionCard>
  );
}

import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import {
  countLabel,
  costLabel,
  incompleteConditions,
  rateLabel,
  simulationText,
  simulationWindows,
  sinceLabel,
  type SimulationAggregate,
  type SimulationSnapshot,
} from "./policy-simulation-state";

export function PolicySimulationResult({
  snapshot,
  result,
  prefixes,
}: {
  snapshot: SimulationSnapshot;
  result: SimulationAggregate;
  prefixes: readonly string[];
}) {
  const incomplete = incompleteConditions(snapshot, prefixes);
  return (
    <div className="policy-simulation-result page-stack">
      <div role="region" tabIndex={0} aria-label="시뮬레이션 결과 읽기">
        내용이 길면 이 안내에 초점을 둔 뒤 위·아래 방향키로 살펴볼 수 있습니다.
      </div>
      <InlineNotice title="정책을 저장하거나 적용하지 않습니다.">
        과거 기록의 잠재 영향을 계산한 결과입니다. 현재 배포 비율이나 미래 요청의 안전성을 보장하지 않습니다.
      </InlineNotice>
      <KeyValueList
        items={[
          { label: "실행한 추천", value: simulationText(snapshot.title, prefixes) },
          { label: "실행한 분석 기간", value: simulationWindows[snapshot.window] },
          {
            label: "실행한 규칙",
            value: (
              <code>
                {simulationText(
                  JSON.stringify({ conditions: snapshot.conditions, actions: snapshot.actions }),
                  prefixes,
                )}
              </code>
            ),
          },
          { label: "조회 시작 기준", value: sinceLabel(result.since) },
          { label: "평가 표본 수", value: countLabel(result.evaluated) },
          { label: "차단 예상", value: countLabel(result.blocked) },
          { label: "승인 요구 예상", value: countLabel(result.approved) },
          { label: "허용 예상", value: countLabel(result.allowed) },
          { label: "차단 비율", value: rateLabel(result.blockRate, result.evaluated) },
          { label: "영향 API 키 수", value: countLabel(result.keys) },
          { label: "영향 팀 수", value: countLabel(result.teams) },
          { label: "오탐 후보", value: countLabel(result.candidates) },
          { label: "오탐 후보 비율", value: rateLabel(result.candidateRate, result.blocked) },
          { label: "차단 대상 표본의 과거 비용", value: costLabel(result.historicalCost) },
        ]}
      />
      {result.evaluated === 0 ? (
        <InlineNotice title="평가할 표본이 없습니다.">
          0개 표본으로 정책의 안전성이나 효과를 판단할 수 없습니다.
        </InlineNotice>
      ) : null}
      {result.evaluated !== undefined && result.evaluated >= 5000 ? (
        <InlineNotice tone="warning" title="표본 상한에 도달했을 수 있습니다.">
          상한 이후의 기록이나 전체 영향 규모는 이 응답으로 확인할 수 없습니다.
        </InlineNotice>
      ) : null}
      {incomplete.length ? (
        <InlineNotice tone="warning" title="당시 값을 복원하지 못하는 조건이 있습니다.">
          {incomplete.join(", ")}. 빈값·기본값으로 평가되거나 일치하지 않을 수 있어 결과 해석이 제한됩니다.
          해당 조건을 무시한 계산이라는 뜻은 아닙니다.
        </InlineNotice>
      ) : null}
      <div className="policy-simulation-notes">
        <p>
          조회 시점의 최근 기록을 최대 5,000개 표본으로 계산합니다. 시작 기준만 제공되며 고정된 집계 종료
          시각은 없습니다. 같은 기간을 다시 실행해도 표본은 달라질 수 있습니다.
        </p>
        <p>
          표본 수는 조인된 기록 수이며 고유 요청 수를 보장하지 않습니다. 추천의 근거 기간과 이 분석 기간은
          다를 수 있습니다.
        </p>
        <p>
          영향 API 키·팀 수는 차단 대상의 비어 있지 않은 값만 집계합니다. 팀 값은 현재 API 키의 팀 정보이며
          당시 소속을 복원한 것이 아닙니다.
        </p>
        <p>
          오탐 후보는 과거 성공(2xx) 기록 중 차단 예상 표본이며, 비율의 분모는 차단 예상 표본입니다. 실제 오탐
          판정은 아닙니다.
        </p>
        <p>
          과거 비용은 기록된 추정 비용의 합계이며 청구액이나 미래 절감액이 아닙니다. 응답의 0과 누락은
          구분하지만 원기록의 결측값이 0으로 집계됐는지는 구분할 수 없습니다.
        </p>
      </div>
    </div>
  );
}

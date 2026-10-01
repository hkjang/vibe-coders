import type { TraceSafeFlow } from "@/shared/api/domains/trace-safe-flow.schema";
import { flowDisplay } from "./trace-safe-flow-display";
import { flowTimeline } from "./trace-safe-flow-timeline";
import { formatTraceDate } from "./trace-utils";

const kinds = { request: "요청", text2sql: "텍스트 SQL 단계", tool: "도구", mcp_tool: "MCP 도구" };
const statuses = { ok: "정상", error: "오류", skipped: "건너뜀", unknown: "확인 불가" };
export function TraceSafeFlowResult({
  data,
  prefixes,
  timeZone,
}: {
  data: TraceSafeFlow;
  prefixes: readonly string[];
  timeZone: string;
}) {
  const count = data.spans.length - 1;
  const timeline = flowTimeline(data.spans);
  const timestamp = (value: string) => {
    const safe = flowDisplay(value, prefixes);
    return safe === value ? (
      <time dateTime={value} title={value}>
        {formatTraceDate(value, timeZone, { dateStyle: "medium", timeStyle: "medium" })}
      </time>
    ) : (
      safe
    );
  };
  return (
    <>
      <p>
        표시된 하위 단계 {count.toLocaleString("ko-KR")}개 · 조회 생성 시각 {timestamp(data.generated_at)}
      </p>
      {count === 0 ? (
        <p role="status">
          표시할 하위 단계가 없습니다. 단계의 존재 여부나 기록의 완전성을 판단할 수 없습니다.
        </p>
      ) : null}
      <div className="trace-safe-flow-table" role="region" aria-label="단계 표 가로 스크롤" tabIndex={0}>
        <table aria-label="기록된 요청 단계와 시간">
          <thead>
            <tr>
              <th scope="col">단계</th>
              <th scope="col">상태</th>
              <th scope="col">기록 시각</th>
              <th scope="col">기록 상대 위치</th>
              <th scope="col">기록된 지연</th>
              <th scope="col">기록 타임라인</th>
            </tr>
          </thead>
          <tbody>
            {data.spans.map((span, index) => (
              <tr key={span.span_ref}>
                <th scope="row">
                  <span aria-hidden="true">{index === 0 ? "" : "↳ "}</span>
                  {index > 0 ? <span className="sr-only">요청 기록의 하위 단계: </span> : null}
                  {flowDisplay(span.name, prefixes)}
                  <small>{kinds[span.kind]}</small>
                </th>
                <td>{statuses[span.status]}</td>
                <td>{span.recorded_at === null ? "기록 시각 확인 불가" : timestamp(span.recorded_at)}</td>
                <td>
                  {span.offset_ms === null
                    ? "확인 불가"
                    : `${span.offset_ms > 0 ? "+" : ""}${span.offset_ms.toLocaleString("ko-KR")} ms`}
                </td>
                <td>
                  {span.kind === "tool" || span.kind === "mcp_tool"
                    ? "소요 시간 미기록"
                    : span.duration_ms === null
                      ? "확인 불가"
                      : `${span.duration_ms.toLocaleString("ko-KR")} ms (기록값)`}
                </td>
                <td>
                  {timeline[index] ? (
                    <span className="trace-safe-flow-track" aria-hidden="true">
                      <span
                        className={timeline[index].point ? "trace-safe-flow-point" : "trace-safe-flow-bar"}
                        style={{ left: `${timeline[index].left}%`, width: `${timeline[index].width}%` }}
                      />
                    </span>
                  ) : (
                    "기록 위치 미기록"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="trace-safe-flow-coverage">
        {(["tools", "text2sql"] as const).map((kind) => (
          <div key={kind}>
            <dt>{kind === "tools" ? "도구 기록 범위" : "텍스트 SQL 기록 범위"}</dt>
            <dd>
              후보 최대 {data.coverage[kind].limit}개 · 표시 생략 {data.coverage[kind].omitted}개 ·{" "}
              {data.coverage[kind].truncated
                ? "조회 상한 초과: 일부 후보만 확인했습니다."
                : "조회 상한 초과 없음"}
            </dd>
          </div>
        ))}
      </dl>
      <p>
        생략은 조회한 후보 중 표시 대상이 아닌 기록입니다. 상한에 따른 부분 집합은 전체·최초 단계나 항상
        동일한 순서를 보장하지 않습니다. 타임라인은 기록 위치와 지연의 시각적 비교이며 점은 길이를 확정할 수
        없거나 기록값이 0인 단계입니다.
      </p>
    </>
  );
}

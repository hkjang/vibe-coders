import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { apiClient } from "@/shared/api/client";
import type { RequestDiffSide } from "@/shared/api/domains/observability.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";

const routeId = "observability.requests";

interface RequestComparePanelProps {
  requestId: string;
}

function sideRows(side: RequestDiffSide | null | undefined): Array<[string, string]> {
  const request = side?.request;
  return [
    ["요청 ID", request?.id ?? "—"],
    ["모델", request?.model || "—"],
    ["공급자", request?.provider || "—"],
    ["상태", request?.status_code ? `HTTP ${request.status_code}` : "—"],
    ["지연", formatDuration(request?.latency_ms ?? 0)],
    [
      "토큰",
      `${formatNumber(request?.prompt_tokens ?? 0)} / ${formatNumber(request?.completion_tokens ?? 0)} / ${formatNumber(request?.total_tokens ?? 0)}`,
    ],
    ["비용", formatKRW(request?.estimated_cost ?? 0)],
  ];
}

/**
 * Compares this request with another by id. Like the rest of the request explorer it
 * shows operational metadata only — prompts and response bodies stay out of the
 * preview, so a comparison cannot become a way to read them.
 */
export function RequestComparePanel({ requestId }: RequestComparePanelProps): React.JSX.Element {
  const [other, setOther] = useState("");
  const [compareWith, setCompareWith] = useState("");

  const diff = useQuery({
    enabled: compareWith !== "",
    queryKey: ["observability", "requests", requestId, "diff", compareWith],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.requestDiff, {
        query: { a: requestId, b: compareWith },
        routeId,
        signal,
      }),
  });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setCompareWith(other.trim());
  };

  const rows = sideRows(diff.data?.left);
  const otherRows = sideRows(diff.data?.right);

  return (
    <section className="request-compare" aria-label="다른 요청과 비교">
      <h3>다른 요청과 비교</h3>
      <form className="request-compare-form" onSubmit={submit}>
        <label htmlFor="request-compare-id">비교할 요청 ID</label>
        <Input
          id="request-compare-id"
          maxLength={512}
          value={other}
          onChange={(event) => setOther(event.target.value)}
          placeholder="req_..."
        />
        <Button type="submit" disabled={other.trim() === "" || diff.isFetching}>
          비교
        </Button>
      </form>

      {diff.isError ? (
        <InlineNotice tone="warning" title="두 요청을 비교하지 못했습니다.">
          요청 ID가 맞는지, 두 요청 모두 조회 권한이 있는지 확인해 주세요.
        </InlineNotice>
      ) : null}

      {compareWith !== "" && diff.data ? (
        <table className="data-table">
          <caption className="sr-only">두 요청의 운영 지표 비교</caption>
          <thead>
            <tr>
              <th scope="col">항목</th>
              <th scope="col">이 요청</th>
              <th scope="col">비교 대상</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, value], index) => {
              const otherValue = otherRows[index]?.[1] ?? "—";
              return (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{value}</td>
                  <td className={value === otherValue ? undefined : "request-compare-differs"}>
                    {otherValue}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

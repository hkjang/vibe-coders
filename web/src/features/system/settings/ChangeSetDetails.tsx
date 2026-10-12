import type { ChangeSet, ChangeSetDryRun } from "@/shared/api/domains/system.schemas";
import { changeSetStatusLabel, dryRunTone } from "./change-set-model";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Badge } from "@/shared/components/ui/Badge";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";

export function ChangeSetDetails({
  selected,
  dryRunResult,
}: {
  selected: ChangeSet;
  dryRunResult?: ChangeSetDryRun;
}): React.JSX.Element {
  return (
    <div className="settings-sheet-stack">
      <KeyValueList
        columns={2}
        items={[
          { label: "ID", value: selected.id, mono: true },
          { label: "상태", value: changeSetStatusLabel(selected.status) },
          { label: "생성자", value: selected.created_by ?? "—" },
          { label: "검토자", value: selected.reviewer ?? "—" },
          { label: "카나리 범위", value: selected.canary_scope ?? "—" },
          { label: "생성", value: formatDateTime(selected.created_at) },
          { label: "수정", value: formatDateTime(selected.updated_at) },
          { label: "적용", value: formatDateTime(selected.applied_at) },
        ]}
      />
      {selected.description ? <p>{selected.description}</p> : null}
      {selected.note ? <p>검토 메모: {selected.note}</p> : null}
      {selected.status === "apply_pending" || selected.status === "rollback_pending" ? (
        <InlineNotice tone="warning" title="설정 저장 후 복구 대기 중">
          <p>
            설정은 저장되었지만 응답 서버의 설정 재읽기 또는 완료 기록이 대기 중입니다. 현재 상태를 확인한 뒤
            {selected.status === "apply_pending" ? " 적용" : " 되돌리기"}를 다시 실행하면 설정을 중복 저장하지
            않고 복구를 이어갑니다. 복구를 마치기 전에는 삭제할 수 없습니다.
          </p>
        </InlineNotice>
      ) : null}
      {dryRunResult ? (
        <SectionCard
          headingLevel={3}
          title="적용 미리보기"
          description="현재 값과 제안 값을 비교합니다. 실제로 적용되지 않습니다."
        >
          <InlineNotice
            tone={
              (dryRunResult.invalid_count ?? 0) > 0
                ? "danger"
                : dryRunResult.restart_required
                  ? "warning"
                  : "success"
            }
            title={`변경 ${formatNumber(dryRunResult.changed_count ?? 0)}건 · 오류 ${formatNumber(
              dryRunResult.invalid_count ?? 0,
            )}건`}
          >
            <p>
              {dryRunResult.restart_required
                ? "재시작이 필요한 설정이 포함되어 있습니다."
                : "응답 서버 기준으로 재시작이 필요한 항목이 없습니다. 다른 서버의 즉시 반영을 보장하지 않습니다."}
            </p>
            {dryRunResult.note ? <p>{dryRunResult.note}</p> : null}
          </InlineNotice>
          <div className="data-table-scroll" role="region" aria-label="적용 미리보기 결과 표" tabIndex={0}>
            <table className="data-table">
              <caption className="sr-only">적용 미리보기 결과</caption>
              <thead>
                <tr>
                  <th scope="col">키</th>
                  <th scope="col">현재 값</th>
                  <th scope="col">제안 값</th>
                  <th scope="col">판정</th>
                  <th scope="col">비고</th>
                </tr>
              </thead>
              <tbody>
                {(dryRunResult.checks ?? []).map((check, index) => (
                  <tr key={`${check.key ?? ""}:${index}`}>
                    <th scope="row" className="mono">
                      {check.key || "—"}
                    </th>
                    <td className="mono truncate">{check.current ?? "—"}</td>
                    <td className="mono truncate">{check.proposed ?? "—"}</td>
                    <td>
                      <Badge tone={dryRunTone(check)}>
                        {check.valid === false
                          ? "오류"
                          : check.changed === false
                            ? "변화 없음"
                            : check.restart_required
                              ? "재시작 필요"
                              : "적용 가능"}
                      </Badge>
                    </td>
                    <td>{check.detail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}
      <JsonBlock label="변경 항목" value={selected.items ?? []} />
      <JsonBlock label="적용 전 값(되돌리기용)" value={selected.prior ?? []} />
    </div>
  );
}

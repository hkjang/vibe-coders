import { useMemo, useState } from "react";
import { History } from "lucide-react";
import type { PromptAssetHistoryEntry } from "@/shared/api/domains/prompts";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { formatDateTime, formatRelative } from "@/shared/utils/format";
import { PanelFailure, PromptTable, type PromptColumn } from "./prompt-parts";
import { assetHistoryActionLabel, assetStatusLabel, diffPromptBodies } from "./prompt-utils";
import { useLibraryQuery } from "./use-library-query";
import { readLibraryHistory } from "./library-api";
import { libraryNumber } from "./library-model";
const writeHint = "편집 권한이 없거나 다른 작업을 처리하고 있습니다.";
export function AssetHistory({
  assetId,
  canWrite,
  onRollback,
}: {
  assetId: string;
  canWrite: boolean;
  onRollback: (snapshot: PromptAssetHistoryEntry, trigger: HTMLButtonElement) => void;
}) {
  const [diffAgainst, setDiffAgainst] = useState<number>();
  const history = useLibraryQuery({
    key: ["prompts", "asset-history", assetId],
    read: (prefixes, signal) => readLibraryHistory(assetId, prefixes, signal),
  });
  const historyRows = useMemo(() => history.data?.history ?? [], [history.data]);
  const versions = useMemo(
    () =>
      historyRows
        .filter((entry) => entry.has_snapshot)
        .sort((a, b) => Number(b.version_num) - Number(a.version_num)),
    [historyRows],
  );
  const currentVersion = versions[0]?.version_num;

  const diffLines = useMemo(() => {
    if (diffAgainst === undefined) return [];
    const index = versions.findIndex((entry) => entry.version_num === diffAgainst);
    const newer = versions[index];
    const older = versions[index + 1];
    if (!newer || !older) return [];
    return diffPromptBodies(older.body ?? "", newer.body ?? "");
  }, [diffAgainst, versions]);

  const versionColumns: ReadonlyArray<PromptColumn<PromptAssetHistoryEntry>> = [
    {
      id: "version",
      header: "버전",
      cell: (row) => <strong>{`v${libraryNumber(row.version_num)}`}</strong>,
    },
    {
      id: "action",
      header: "작업",
      cell: (row) => (
        <span>
          {assetHistoryActionLabel(row.action)}
          {row.note ? <span className="prompt-history-meta"> ({row.note})</span> : null}
        </span>
      ),
    },
    { id: "actor", header: "작성자", cell: (row) => row.actor || "—" },
    { id: "created_at", header: "시각", cell: (row) => formatDateTime(row.created_at) },
    {
      id: "actions",
      header: "비교 / 복원",
      cell: (row) => {
        const index = versions.findIndex((entry) => entry.version_num === row.version_num);
        const hasOlder = index >= 0 && versions[index + 1] !== undefined;
        const isCurrent = row.version_num === currentVersion;
        return (
          <span className="prompt-filter-actions">
            {hasOlder ? (
              <Button
                size="small"
                variant="ghost"
                aria-label={`v${libraryNumber(row.version_num)} 이전 버전과 비교`}
                onClick={() => setDiffAgainst(Number(row.version_num))}
              >
                비교
              </Button>
            ) : null}
            {isCurrent ? (
              <span className="prompt-history-meta">현재</span>
            ) : (
              <Button
                size="small"
                disabled={!canWrite}
                title={canWrite ? undefined : writeHint}
                aria-label={`v${libraryNumber(row.version_num)}으로 복원`}
                onClick={(event) => {
                  onRollback(row, event.currentTarget);
                }}
              >
                <History aria-hidden="true" /> 이 버전으로 복원
              </Button>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <section>
        <h3>버전 이력</h3>
        {history.isError ? (
          <PanelFailure
            error={history.error}
            hasData={Boolean(history.data)}
            label="버전 이력"
            onRetry={() => void history.refetch()}
          />
        ) : null}
        <PromptTable
          tableId="versions"
          caption="버전 이력"
          columns={versionColumns}
          rows={versions}
          loading={history.isPending}
          emptyMessage="기록된 버전이 없습니다."
        />
        {diffAgainst !== undefined ? (
          <>
            <h4>{`v${diffAgainst} 이전 버전과의 차이`}</h4>
            <pre className="prompt-diff" tabIndex={0} role="region" aria-label={`v${diffAgainst} 본문 차이`}>
              {diffLines.length === 0
                ? "본문 변경이 없습니다."
                : diffLines.map((line) => (
                    <span
                      key={line.key}
                      className={line.tone === "added" ? "prompt-diff-added" : "prompt-diff-removed"}
                    >
                      {`${line.tone === "added" ? "+" : "-"} ${line.text}`}
                    </span>
                  ))}
            </pre>
          </>
        ) : null}
      </section>

      <section>
        <h3>변경 이력</h3>
        {historyRows.length === 0 ? (
          <EmptyState
            title="변경 이력이 없습니다."
            description="자산을 수정하거나 검토를 진행하면 이곳에 기록이 쌓입니다."
          />
        ) : (
          <ol className="prompt-history-log">
            {historyRows.map((entry) => (
              <li key={entry.id} className="prompt-history-entry">
                <strong>{assetHistoryActionLabel(entry.action)}</strong>
                {entry.has_snapshot ? <Badge>{`v${libraryNumber(entry.version_num)}`}</Badge> : null}
                {entry.from_status || entry.to_status ? (
                  <span className="prompt-history-meta">
                    {`${assetStatusLabel(entry.from_status) || "—"} → ${assetStatusLabel(entry.to_status) || "—"}`}
                  </span>
                ) : null}
                {entry.note ? <span className="prompt-history-meta">{entry.note}</span> : null}
                <span className="prompt-history-meta">
                  {`${entry.actor || "system"} · ${formatRelative(entry.created_at)}`}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

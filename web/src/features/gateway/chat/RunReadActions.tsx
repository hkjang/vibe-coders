import { useState } from "react";
import { useRunRead } from "./use-run-read";
import { Download, GitCompare } from "lucide-react";
import { safeModelLabel } from "./chat-console";
import {
  multiRunExportFormatLabels,
  multiRunExportFormats,
  type MultiRunExportFormat,
} from "./multi-run-export";
import type { CompareAccess } from "./use-compare-access";
import type { MultiRunDiff } from "@/shared/api/domains/gateway.schemas";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Select } from "@/shared/components/ui/Select";
import { formatNumber } from "@/shared/utils/format";

/** Raw read operations are allowed in readonly, with their existing raw-read scope. */
export function RunReadActions({ runId, access }: { runId: string; access: CompareAccess }) {
  const [format, setFormat] = useState<MultiRunExportFormat>("md");
  const { diff, pending, error, run } = useRunRead(runId, access);

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-start">
          <Button
            size="small"
            variant="secondary"
            disabled={pending !== "" || !access.readAllowed}
            title={access.readReason}
            onClick={() => void run("diff")}
          >
            <GitCompare aria-hidden="true" /> {pending === "diff" ? "비교 중" : "답변 비교"}
          </Button>
        </div>
        <div className="toolbar-end">
          <FormField label="내보내기 형식" id={`export-format-${runId}`}>
            {(control) => (
              <Select
                {...control}
                value={format}
                disabled={pending !== ""}
                onChange={(event) => setFormat(event.target.value as MultiRunExportFormat)}
                options={multiRunExportFormats.map((value) => ({
                  value,
                  label: multiRunExportFormatLabels[value],
                }))}
              />
            )}
          </FormField>
          <Button
            size="small"
            variant="secondary"
            disabled={pending !== "" || !access.readAllowed}
            title={access.readReason}
            onClick={() => void run("export", format)}
          >
            <Download aria-hidden="true" /> {pending === "export" ? "내보내는 중" : "서버에서 내보내기"}
          </Button>
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error.message}
          {error.requestId ? <span className="request-id"> 요청 ID: {error.requestId}</span> : null}
        </p>
      ) : null}
      {diff && access.readAllowed ? <RunDiffView diff={diff} /> : null}
    </>
  );
}

/** Block-level comparison of the stored answers; previews stay on this screen only. */
function RunDiffView({ diff }: { diff: MultiRunDiff }): React.JSX.Element {
  return (
    <div className="gateway-run-diff">
      <InlineNotice tone="info" title="답변 비교">
        {`응답한 모델 ${formatNumber(diff.answered_models ?? 0)}개 · 공통 블록 ${formatNumber(diff.common_blocks.length)}개`}
        {diff.note ? ` · ${diff.note}` : ""}
      </InlineNotice>
      <div className="data-table-scroll" tabIndex={0} aria-label="모델별 답변 비교 표 영역">
        <table className="data-table">
          <caption className="sr-only">모델별 공통·누락·고유 블록 수</caption>
          <thead>
            <tr>
              <th scope="col">모델</th>
              <th scope="col">블록</th>
              <th scope="col">누락</th>
              <th scope="col">고유</th>
              <th scope="col">형식</th>
            </tr>
          </thead>
          <tbody>
            {diff.per_model.map((row, index) => (
              <tr key={`${row.model ?? "model"}-${index}`}>
                <td className="mono">{safeModelLabel(row.model)}</td>
                <td className="cell-number">
                  {row.available ? formatNumber(row.block_count ?? 0) : "응답 없음"}
                </td>
                <td className="cell-number">{formatNumber(row.missing?.length ?? 0)}</td>
                <td className="cell-number">{formatNumber(row.extra?.length ?? 0)}</td>
                <td>
                  {row.stats?.has_table ? "표 포함" : "표 없음"}
                  {row.stats?.has_code ? " · 코드 포함" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {diff.models.map((model, index) => (
        <details className="gateway-diff-model" key={`${model.model ?? "model"}-${index}`}>
          <summary>{`${safeModelLabel(model.model)} 블록 ${formatNumber(model.blocks?.length ?? 0)}개`}</summary>
          <ul className="gateway-list">
            {(model.blocks ?? []).map((block, blockIndex) => (
              <li key={`${block.key ?? blockIndex}`}>
                <strong>{block.type ?? "블록"}</strong>
                <span className="truncate">{block.preview ?? ""}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

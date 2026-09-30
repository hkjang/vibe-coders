import { useRef, useState } from "react";
import { ModelContractDialog } from "./ModelContractDialog";
import { ModelContractRunPanel } from "./ModelContractRunPanel";
import { ModelQueryFailure } from "./ModelGovernanceState";
import { modelIdentityReason, modelPrecisionReason, safeModelTarget } from "./model-governance-form";
import {
  useModelContracts,
  useModelGovernanceMutations,
  useModelListPrerequisite,
} from "./use-model-governance";
import type { ModelContract } from "@/shared/api/domains/gateway.schemas";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";

export function ModelContractsPanel() {
  const query = useModelContracts();
  const { access, saveContract, removeContract } = useModelGovernanceMutations();
  const list = useModelListPrerequisite("contracts");
  const reason = access.write.reason ?? list.reason;
  const [editing, setEditing] = useState<{ row?: ModelContract; epoch: number; instance: number }>();
  const [removing, setRemoving] = useState<{ id: string; name: string; epoch: number }>();
  const serial = useRef(0);
  const triggers = useRef(new Map<string, HTMLElement>());
  const target = useRef<string | undefined>(undefined);
  const activeTrigger = useRef<HTMLElement | null>(null);
  const returnFocusRef = {
    get current() {
      return (target.current ? triggers.current.get(target.current) : undefined) ?? activeTrigger.current;
    },
  };
  const remember = (node: HTMLElement, key: string) => {
    target.current = key;
    activeTrigger.current = node;
  };
  const safeRow = (row: ModelContract) =>
    safeModelTarget(row.id, "contract") &&
    query.data?.contracts.filter((item) => item.id === row.id).length === 1;
  return (
    <div className="page-stack">
      <SectionCard
        title="모델 계약"
        description="작업 유형별로 관측 지표와 비교할 품질·지연·비용 기준입니다. 저장만으로 모델을 호출하거나 교체하지 않습니다."
        actions={
          <Button
            size="small"
            variant="primary"
            disabled={reason !== undefined}
            title={reason}
            onClick={(event) => {
              if (reason) return;
              remember(event.currentTarget, "create");
              setEditing({ epoch: access.epoch, instance: ++serial.current });
            }}
            ref={(node) => {
              if (node) triggers.current.set("create", node);
              else triggers.current.delete("create");
            }}
          >
            계약 추가
          </Button>
        }
      >
        {reason ? <InlineNotice tone="warning">{reason}</InlineNotice> : null}
        <Button
          size="small"
          variant="secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          계약 목록 다시 조회
        </Button>
        {query.isPending ? (
          <LoadingState label="모델 계약을 불러오는 중입니다." />
        ) : query.isError ? (
          <ModelQueryFailure
            title="모델 계약을 불러오지 못했습니다."
            error={query.error}
            retry={() => void query.refetch()}
          />
        ) : query.data.contracts.length === 0 ? (
          <EmptyState
            title="등록된 모델 계약이 없습니다."
            description="품질·지연·비용의 관측 지표를 비교할 기준을 등록하세요."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="모델 계약 표 영역">
            <table className="data-table">
              <caption className="sr-only">작업 유형별 모델 계약</caption>
              <thead>
                <tr>
                  <th scope="col">이름</th>
                  <th scope="col">작업 유형</th>
                  <th scope="col">품질 ≥</th>
                  <th scope="col">골든 ≥</th>
                  <th scope="col">성공률 ≥</th>
                  <th scope="col">지연 ≤</th>
                  <th scope="col">비용 ≤</th>
                  <th scope="col">사용</th>
                  <th scope="col">작업</th>
                </tr>
              </thead>
              <tbody>
                {query.data.contracts.map((row, index) => (
                  <tr key={`${row.id}-${index}`}>
                    <td>{row.name}</td>
                    <td>{row.task_type || "-"}</td>
                    <td>{row.min_quality_score}</td>
                    <td>{row.min_golden_pass_rate}</td>
                    <td>{row.min_success_rate}</td>
                    <td>{row.max_latency_ms} ms</td>
                    <td>{row.max_avg_cost_krw}</td>
                    <td>
                      <Badge tone={row.enabled ? "success" : "muted"}>{row.enabled ? "사용" : "중지"}</Badge>
                    </td>
                    <td>
                      <div className="gateway-row-actions">
                        {(["edit", "delete"] as const).map((action) => (
                          <Button
                            key={action}
                            size="small"
                            variant="ghost"
                            disabled={
                              reason !== undefined ||
                              !safeRow(row) ||
                              (action === "edit" && !Number.isSafeInteger(row.max_latency_ms))
                            }
                            title={
                              reason ??
                              (!safeRow(row)
                                ? modelIdentityReason
                                : action === "edit" && !Number.isSafeInteger(row.max_latency_ms)
                                  ? modelPrecisionReason
                                  : undefined)
                            }
                            ref={(node) => {
                              const key = `${action}:${row.id}`;
                              if (node) triggers.current.set(key, node);
                              else triggers.current.delete(key);
                            }}
                            onClick={(event) => {
                              if (
                                reason ||
                                !safeRow(row) ||
                                (action === "edit" && !Number.isSafeInteger(row.max_latency_ms))
                              )
                                return;
                              remember(event.currentTarget, `${action}:${row.id}`);
                              if (action === "edit")
                                setEditing({
                                  row: { ...row },
                                  epoch: access.epoch,
                                  instance: ++serial.current,
                                });
                              else setRemoving({ id: row.id, name: row.name, epoch: access.epoch });
                            }}
                          >
                            {action === "edit" ? "수정" : "삭제"}
                          </Button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      <ModelContractRunPanel key={access.epoch} />
      {editing?.epoch === access.epoch ? (
        <ModelContractDialog
          key={editing.instance}
          row={editing.row}
          onClose={() => setEditing(undefined)}
          save={saveContract.mutateAsync}
          returnFocusRef={returnFocusRef}
          queryError={query.error}
          refresh={() => void query.refetch()}
          refreshing={query.isFetching}
        />
      ) : null}
      {removing?.epoch === access.epoch ? (
        <ConfirmDialog
          key={`${access.epoch}:${removing.id}`}
          open
          title="모델 계약 삭제"
          description={`${removing.name} 계약을 삭제합니다. 이후 검증에서 제외됩니다. 다른 관리자의 동시 변경을 막지는 않습니다.`}
          confirmLabel="삭제"
          tone="danger"
          confirmDisabled={reason !== undefined}
          returnFocusRef={returnFocusRef}
          onOpenChange={(open) => {
            if (!open) setRemoving(undefined);
          }}
          onConfirm={async () => {
            access.write.assertCurrent();
            await removeContract.mutateAsync(removing.id);
          }}
        >
          {reason ? <InlineNotice tone="warning">{reason}</InlineNotice> : null}
          {query.error ? (
            <ModelQueryFailure
              title="모델 계약 목록을 확인하지 못했습니다."
              error={query.error}
              retry={() => void query.refetch()}
              disabled={removeContract.isPending || query.isFetching}
            />
          ) : (
            <Button
              size="small"
              variant="secondary"
              disabled={removeContract.isPending || query.isFetching}
              onClick={() => void query.refetch()}
            >
              계약 목록 다시 조회
            </Button>
          )}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

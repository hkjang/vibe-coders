import { useRef, useState } from "react";
import { ModelDeprecationDialog } from "./ModelDeprecationDialog";
import { ModelQueryFailure } from "./ModelGovernanceState";
import { modelIdentityReason, safeModelTarget } from "./model-governance-form";
import {
  useModelDeprecations,
  useModelGovernanceMutations,
  useModelListPrerequisite,
} from "./use-model-governance";
import type { ModelDeprecation } from "@/shared/api/domains/gateway.schemas";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";

export function ModelDeprecationsPanel() {
  const query = useModelDeprecations();
  const { access, saveDeprecation, removeDeprecation } = useModelGovernanceMutations();
  const list = useModelListPrerequisite("deprecations");
  const reason = access.write.reason ?? list.reason;
  const [editing, setEditing] = useState<{ epoch: number; instance: number }>();
  const [removing, setRemoving] = useState<{ id: string; glob: string; epoch: number }>();
  const serial = useRef(0);
  const nodes = useRef(new Map<string, HTMLElement>());
  const target = useRef<string | undefined>(undefined);
  const original = useRef<HTMLElement | null>(null);
  const returnFocusRef = {
    get current() {
      return (target.current ? nodes.current.get(target.current) : undefined) ?? original.current;
    },
  };
  const remember = (node: HTMLElement, key: string) => {
    target.current = key;
    original.current = node;
  };
  const safeRow = (row: ModelDeprecation) =>
    safeModelTarget(row.id, "deprecation") &&
    query.data?.deprecations.filter((item) => item.id === row.id).length === 1;
  return (
    <SectionCard
      title="모델 지원 종료"
      description="종료일(UTC) 전에는 경고하며, 날짜에 도달하면 대체 모델로 다시 쓰거나 차단합니다. 날짜가 없으면 경고만 합니다. 여러 인스턴스에는 캐시 반영 시차가 있을 수 있습니다."
      actions={
        <Button
          size="small"
          variant="primary"
          disabled={reason !== undefined}
          title={reason}
          ref={(node) => {
            if (node) nodes.current.set("create", node);
            else nodes.current.delete("create");
          }}
          onClick={(event) => {
            if (reason) return;
            remember(event.currentTarget, "create");
            setEditing({ epoch: access.epoch, instance: ++serial.current });
          }}
        >
          정책 추가
        </Button>
      }
    >
      {reason ? <InlineNotice tone="warning">{reason}</InlineNotice> : null}
      <p>
        같은 정규화 패턴은 서버가 생성한 기존 정책을 갱신합니다. 별도 ID로 가져온 항목은 그대로 남고 새 항목이
        생성될 수 있습니다.
      </p>
      <Button
        size="small"
        variant="secondary"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        정책 목록 다시 조회
      </Button>
      {query.isPending ? (
        <LoadingState label="지원 종료 정책을 불러오는 중입니다." />
      ) : query.isError ? (
        <ModelQueryFailure
          title="지원 종료 정책을 불러오지 못했습니다."
          error={query.error}
          retry={() => void query.refetch()}
        />
      ) : query.data.deprecations.length === 0 ? (
        <EmptyState
          title="등록된 지원 종료 정책이 없습니다."
          description="종료할 모델 패턴과 UTC 종료일을 등록하세요. 같은 정규화 패턴은 서버가 생성한 기존 정책을 갱신합니다."
        />
      ) : (
        <div className="data-table-scroll" tabIndex={0} aria-label="모델 지원 종료 정책 표 영역">
          <table className="data-table">
            <caption className="sr-only">모델 지원 종료 정책</caption>
            <thead>
              <tr>
                <th scope="col">모델 패턴</th>
                <th scope="col">대체 모델</th>
                <th scope="col">종료일(UTC)</th>
                <th scope="col">안내 문구</th>
                <th scope="col">작업</th>
              </tr>
            </thead>
            <tbody>
              {query.data.deprecations.map((row, index) => (
                <tr key={`${row.id}-${index}`}>
                  <td className="mono">{row.model_glob}</td>
                  <td>{row.replacement || "없음(종료일 이후 차단)"}</td>
                  <td>{row.sunset_date || "경고만"}</td>
                  <td>{row.message || "-"}</td>
                  <td>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={reason !== undefined || !safeRow(row)}
                      title={reason ?? (safeRow(row) ? undefined : modelIdentityReason)}
                      ref={(node) => {
                        if (node) nodes.current.set(row.id, node);
                        else nodes.current.delete(row.id);
                      }}
                      onClick={(event) => {
                        if (reason || !safeRow(row)) return;
                        remember(event.currentTarget, row.id);
                        setRemoving({ id: row.id, glob: row.model_glob, epoch: access.epoch });
                      }}
                    >
                      삭제
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing?.epoch === access.epoch ? (
        <ModelDeprecationDialog
          key={editing.instance}
          close={() => setEditing(undefined)}
          save={saveDeprecation.mutateAsync}
          returnFocusRef={returnFocusRef}
          refresh={() => void query.refetch()}
          refreshing={query.isFetching}
          queryError={query.error}
        />
      ) : null}
      {removing?.epoch === access.epoch ? (
        <ConfirmDialog
          key={`${access.epoch}:${removing.id}`}
          open
          title="지원 종료 정책 삭제"
          description={`${removing.glob} 정책을 삭제합니다. 삭제된 정책의 경고·대체·차단은 캐시 갱신 후 중단되며 다른 일치 정책은 남을 수 있습니다.`}
          confirmLabel="삭제"
          tone="danger"
          confirmDisabled={reason !== undefined}
          returnFocusRef={returnFocusRef}
          onOpenChange={(open) => {
            if (!open) setRemoving(undefined);
          }}
          onConfirm={async () => {
            access.write.assertCurrent();
            await removeDeprecation.mutateAsync(removing.id);
          }}
        >
          {reason ? <InlineNotice tone="warning">{reason}</InlineNotice> : null}
          {query.error ? (
            <ModelQueryFailure
              title="지원 종료 정책 목록을 확인하지 못했습니다."
              error={query.error}
              retry={() => void query.refetch()}
              disabled={query.isFetching || removeDeprecation.isPending}
            />
          ) : (
            <Button
              size="small"
              variant="secondary"
              disabled={query.isFetching || removeDeprecation.isPending}
              onClick={() => void query.refetch()}
            >
              정책 목록 다시 조회
            </Button>
          )}
        </ConfirmDialog>
      ) : null}
    </SectionCard>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type RefObject } from "react";

import { opsRouteId } from "@/features/system/health/OpsHomeTab";
import { QueryNotice } from "@/features/system/settings/SettingsParts";
import { apiClient } from "@/shared/api/client";
import type { MigrationSqlStatement } from "@/shared/api/domains/system.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";

const kindLabels: Record<string, string> = {
  add_column: "컬럼 추가",
  create_index: "인덱스",
  create_table: "테이블",
  other: "기타",
};

const indexStatusLabels: Record<string, string> = {
  mismatched: "정의 불일치",
  missing: "DB에 없음",
  present: "적용됨",
};

const indexStatusTones: Record<string, "danger" | "success" | "warning"> = {
  mismatched: "danger",
  missing: "warning",
  present: "success",
};

interface MigrationSqlDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
}

/**
 * The declared schema, in apply order, annotated with what this database has.
 *
 * An operator who has been adding indexes by hand cannot tell from the database which
 * ones came from the build: the drift report only covers the ones that disagree. This
 * list is the reference for that question. It displays DDL and never runs it.
 */
export function MigrationSqlDialog({
  onOpenChange,
  open,
  returnFocusRef,
}: MigrationSqlDialogProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [driftOnly, setDriftOnly] = useState(false);

  const report = useQuery({
    enabled: open,
    queryKey: ["system", "ops", "migration-sql"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.system.ops.migrationSql, { routeId: opsRouteId, signal }),
  });

  const indexStatus = report.data?.index_status ?? {};
  const indexDetail = report.data?.index_detail ?? {};

  const rows = useMemo(() => {
    const status = report.data?.index_status ?? {};
    const needle = query.trim().toLowerCase();
    const statusOf = (statement: MigrationSqlStatement): string | undefined =>
      statement.name ? status[statement.name] : undefined;
    return (report.data?.statements ?? []).filter((statement) => {
      if (kind !== "all" && (statement.kind ?? "other") !== kind) return false;
      if (driftOnly) {
        const declared = statusOf(statement);
        if (declared === undefined || declared === "present") return false;
      }
      if (needle === "") return true;
      const haystack = [statement.sql, statement.table, statement.name, statement.column]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [driftOnly, kind, query, report.data]);

  const counts = report.data?.counts;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title="마이그레이션 SQL"
      description="빌드가 선언한 문장 전부를 적용 순서 그대로 보여줍니다. 이 화면은 어떤 DDL도 실행하지 않습니다."
    >
      {report.isError ? (
        <QueryNotice
          error={report.error}
          hasPreviousData={report.data !== undefined}
          label="마이그레이션 SQL"
          onRetry={() => void report.refetch()}
        />
      ) : null}

      {report.data?.live_error ? (
        <InlineNotice tone="warning" title="이 데이터베이스와 비교하지 못했습니다.">
          {report.data.live_error} 선언한 스키마는 그대로 표시합니다.
        </InlineNotice>
      ) : null}

      <p className="metric-note">
        {report.data?.dialect ? `${report.data.dialect} · ` : ""}
        전체 {counts?.total ?? 0} · 테이블 {counts?.create_table ?? 0} · 인덱스 {counts?.create_index ?? 0} ·
        컬럼 추가 {counts?.add_column ?? 0}
        {counts?.rewritten ? ` · 이 방언에 맞춰 다시 쓴 문장 ${counts.rewritten}` : ""}
      </p>

      <div className="ops-sql-filters">
        <label className="settings-filter" htmlFor="migration-sql-search">
          <span>검색</span>
          <Input
            id="migration-sql-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="테이블, 인덱스, 문장"
          />
        </label>
        <label className="settings-filter" htmlFor="migration-sql-kind">
          <span>구분</span>
          <Select
            id="migration-sql-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            options={[
              { label: "전체", value: "all" },
              { label: "테이블", value: "create_table" },
              { label: "인덱스", value: "create_index" },
              { label: "컬럼 추가", value: "add_column" },
              { label: "기타", value: "other" },
            ]}
          />
        </label>
        <Checkbox
          label="이 DB와 다른 인덱스만"
          checked={driftOnly}
          onChange={(event) => setDriftOnly(event.target.checked)}
        />
      </div>

      {report.isPending ? (
        <p className="metric-note">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="조건에 맞는 문장이 없습니다."
          description="검색어나 구분을 바꾸면 선언된 다른 문장을 볼 수 있습니다."
        />
      ) : (
        <ol className="ops-sql-list" aria-label="선언된 마이그레이션 문장">
          {rows.map((statement) => {
            const status = statement.name ? indexStatus[statement.name] : undefined;
            return (
              <li key={`${statement.seq ?? 0}-${statement.sql}`}>
                <div className="ops-card-head">
                  <span className="metric-note">#{statement.seq ?? 0}</span>
                  <Badge tone="muted">{kindLabels[statement.kind ?? "other"] ?? "기타"}</Badge>
                  {statement.table ? <span className="mono">{statement.table}</span> : null}
                  {status ? (
                    <Badge tone={indexStatusTones[status] ?? "muted"}>
                      {indexStatusLabels[status] ?? status}
                    </Badge>
                  ) : null}
                </div>
                {statement.name && indexDetail[statement.name] ? (
                  <p className="metric-note">{indexDetail[statement.name]}</p>
                ) : null}
                <code className="ops-sql">{statement.sql}</code>
                {statement.declared_sql ? (
                  <p className="metric-note">선언 원문: {statement.declared_sql}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {report.data?.post_migration?.length ? (
        <InlineNotice tone="info" title="목록 이후에 적용되는 변경">
          {report.data.post_migration.join(", ")}
        </InlineNotice>
      ) : null}
    </Dialog>
  );
}

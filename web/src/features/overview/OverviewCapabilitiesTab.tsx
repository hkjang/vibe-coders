import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatNumber } from "@/shared/utils/format";

/** Capability map (GET /admin/capabilities): what the gateway can do and where it lives. */
export function OverviewCapabilitiesTab(): React.JSX.Element {
  const [search, setSearch] = useState("");
  const capabilities = useQuery({
    queryKey: ["admin", "capabilities"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.capabilities, {
        signal,
        routeId: "overview.capabilities",
      }),
    staleTime: 5 * 60_000,
  });

  const searchInvalid = containsPotentialSecret(search);
  const rows = useMemo(() => {
    const all = capabilities.data?.capabilities ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === "" || searchInvalid) return all;
    return all.filter((item) =>
      [item.name, item.key, item.group, ...item.apis, ...item.ui_tabs, ...item.tables]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [capabilities.data, search, searchInvalid]);

  if (capabilities.isPending) {
    return (
      <div role="status" aria-live="polite">
        기능 맵을 불러오는 중입니다.
      </div>
    );
  }

  if (capabilities.isError) {
    return (
      <InlineNotice
        tone="danger"
        title="기능 맵을 불러오지 못했습니다."
        actions={
          <Button size="small" onClick={() => void capabilities.refetch()}>
            다시 시도
          </Button>
        }
      >
        {safeAppErrorMessage(capabilities.error, "기능 맵을 불러오지 못했습니다.")}
        {isAppError(capabilities.error) && capabilities.error.requestId ? (
          <span className="request-id"> 요청 ID: {capabilities.error.requestId}</span>
        ) : null}
      </InlineNotice>
    );
  }

  const groups = Object.entries(capabilities.data?.groups ?? {});

  return (
    <div className="overview-usage-stack">
      <StatGrid label="기능 그룹">
        <StatCard label="전체 기능" value={formatNumber(capabilities.data?.count ?? 0)} />
        {groups.map(([group, count]) => (
          <StatCard key={group} label={group} value={formatNumber(count)} />
        ))}
      </StatGrid>

      <Toolbar label="기능 맵 검색">
        <label>
          기능 검색
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="이름, 키, API, 화면"
            aria-invalid={searchInvalid ? "true" : undefined}
            aria-describedby={searchInvalid ? "capability-search-error" : undefined}
          />
        </label>
      </Toolbar>
      {searchInvalid ? (
        <p className="form-error" role="alert" id="capability-search-error">
          {secretSearchMessage}
        </p>
      ) : null}

      <SectionCard
        title="기능 맵"
        description={capabilities.data?.note ?? "게이트웨이가 제공하는 기능과 연결된 API·화면·테이블입니다."}
      >
        {rows.length === 0 ? (
          <EmptyState
            title="검색 결과가 없습니다."
            description="다른 이름이나 API 경로로 다시 검색해 보세요."
            actions={<Button onClick={() => setSearch("")}>검색 초기화</Button>}
          />
        ) : (
          <div className="obs-capability-grid">
            {rows.map((item) => (
              <article key={item.key} className="obs-capability-card">
                <h3>{item.name}</h3>
                <p>{item.description}</p>
                <div className="obs-timeline-badges">
                  <Badge tone="info">{item.group}</Badge>
                  <Badge tone="muted">{item.key}</Badge>
                </div>
                {item.ui_tabs.length > 0 ? (
                  <div>
                    <strong>화면</strong>
                    <ul className="obs-tag-list">
                      {item.ui_tabs.map((tabId) => (
                        <li key={tabId}>
                          <Badge tone="muted">{tabId}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {item.apis.length > 0 ? (
                  <div>
                    <strong>API</strong>
                    <ul className="obs-tag-list">
                      {item.apis.map((api) => (
                        <li key={api} className="mono">
                          {api}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {item.scopes.length > 0 ? (
                  <div>
                    <strong>권한</strong>
                    <ul className="obs-tag-list">
                      {item.scopes.map((scope) => (
                        <li key={scope}>
                          <Badge tone="warning">{scope}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

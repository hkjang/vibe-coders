import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "react-router";
import { rejectedSensitiveQuery } from "@/shared/security/app-route-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { FormField } from "@/shared/components/form/FormField";
import { Tabs, TabPanel } from "@/shared/components/ui/Tabs";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { TeamDashboardTab } from "./TeamDashboardTab";
import { TeamPortalTab } from "./TeamPortalTab";
import { TeamBoundary } from "./TeamBoundary";
import { useTeamScope } from "./team-context";
import { teamWindowLabel, teamWindows, validTeamText } from "./team-model";
import "@/features/access/access.css";
import "./team.css";

export function TeamPage() {
  const auth = useAuth();
  const location = useLocation();
  const [params] = useSearchState();
  const canOverride =
    auth.user?.scopes.includes("admin:read") ?? (auth.mode === "legacy" || auth.mode === "open");
  const requested = params.get("team")?.trim() ?? "";
  const window = teamWindows.find((value) => value === params.get("window")) ?? "30d";
  const invalid =
    rejectedSensitiveQuery(location.state, "team") ||
    (Boolean(requested) && !validTeamText(requested, auth.credentialPrefixes));
  const ownTeam = auth.user?.team_id ?? "";
  const ownInvalid = Boolean(ownTeam) && !validTeamText(ownTeam, auth.credentialPrefixes);
  const problem = invalid
    ? "팀 이름은 제어 문자와 비밀값 없이 120자 이내로 입력하세요."
    : requested && !canOverride
      ? "다른 팀을 선택하려면 admin:read 권한이 필요합니다."
      : !requested && ownInvalid
        ? "계정의 팀 정보를 확인하지 못했습니다. 관리자에게 팀 배정을 확인하세요."
        : "";
  const queryTeam = problem ? "" : requested;
  const team = queryTeam || (ownInvalid ? "" : ownTeam);
  return (
    <TeamBoundary
      key={JSON.stringify([team, queryTeam, problem])}
      team={team}
      queryTeam={queryTeam}
      window={window}
    >
      <TeamContent canOverride={canOverride} problem={problem} requested={invalid ? "" : requested} />
    </TeamBoundary>
  );
}

function TeamContent({
  canOverride,
  problem,
  requested,
}: {
  canOverride: boolean;
  problem: string;
  requested: string;
}) {
  const scope = useTeamScope();
  const auth = useAuth();
  const client = useQueryClient();
  const [params, update] = useSearchState();
  const [tab, setTab] = useTabParam(["dashboard", "portal"] as const);
  const [input, setInput] = useState(requested);
  const [error, setError] = useState("");
  const access = useFeatureMutationAccess(["team.home"], auth.user?.scopes.includes("team:read") ?? true);
  const clearTablePages = Object.fromEntries(
    [...params.keys()].filter((key) => key.endsWith("_page")).map((key) => [key, undefined]),
  );
  return (
    <div className="page-stack">
      <PageHeader
        title="팀 대시보드"
        status="preview"
        description="선택한 팀의 사용량과 비용, 운영 위험, 공유 리포트를 확인합니다."
        legacyHref="/admin#/team"
        actions={
          <Button
            variant="primary"
            disabled={Boolean(problem) || !scope.team}
            onClick={() =>
              void client.invalidateQueries({
                predicate: (query) =>
                  query.queryKey.at(-2) === scope.owner.marker && query.queryKey.at(-1) === scope.owner.id,
              })
            }
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />
      <form
        className="team-scope-controls"
        aria-label="팀과 조회 기간"
        onSubmit={(event) => {
          event.preventDefault();
          const value = input.trim();
          if (value && !validTeamText(value, auth.credentialPrefixes)) {
            setError("팀 이름은 제어 문자와 비밀값 없이 120자 이내로 입력하세요.");
            return;
          }
          setError("");
          update({ ...clearTablePages, team: value || undefined });
        }}
      >
        {canOverride ? (
          <FormField
            id="team-selection"
            label="팀"
            error={error}
            description="한글 이름 또는 팀 ID를 입력하세요. 비우면 내 팀을 조회합니다."
          >
            {(control) => (
              <Input
                {...control}
                autoComplete="off"
                value={input}
                maxLength={120}
                onChange={(event) => setInput(event.target.value)}
                placeholder="예: 데이터 플랫폼"
              />
            )}
          </FormField>
        ) : (
          <p className="team-scope-name">
            조회 팀 <strong>{scope.team || "미지정"}</strong>
          </p>
        )}
        <FormField id="team-window" label="사용량 조회 기간">
          {(control) => (
            <Select
              {...control}
              value={scope.window}
              onChange={(event) => update({ ...clearTablePages, window: event.target.value })}
            >
              {teamWindows.map((value) => (
                <option key={value} value={value}>
                  {teamWindowLabel(value)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        {canOverride ? <Button type="submit">팀 적용</Button> : null}
        {requested ? (
          <Button type="button" onClick={() => update({ ...clearTablePages, team: undefined })}>
            내 팀 보기
          </Button>
        ) : null}
      </form>
      {problem || !scope.team ? (
        <InlineNotice tone="warning" title={problem ? "팀 선택을 확인하세요." : "배정된 팀이 없습니다."}>
          {problem || "관리자에게 팀 배정을 요청하거나 조회할 팀을 직접 선택하세요."}
        </InlineNotice>
      ) : (
        <>
          <p className="team-scope-summary">
            조회 팀 <strong>{scope.team}</strong> · 사용량 {teamWindowLabel(scope.window)}. 위험은 최근 7일,
            시작 안내는 최근 90일, 예산은 이번 달 기준입니다.
          </p>
          {!access.allowed ? (
            <InlineNotice tone="info" title="읽기 전용으로 열려 있습니다.">
              리포트 검토 내용은 유지되며 승인·반려는 실행할 수 없습니다.
            </InlineNotice>
          ) : null}
          <Tabs
            ariaLabel="팀 화면 영역"
            items={[
              { id: "dashboard", label: "팀 대시보드" },
              { id: "portal", label: "팀 포털" },
            ]}
            value={tab}
            onChange={setTab}
            panelIdPrefix="team"
          />
          {tab === "dashboard" ? (
            <TabPanel id="dashboard" panelIdPrefix="team">
              <TeamDashboardTab />
            </TabPanel>
          ) : (
            <TabPanel id="portal" panelIdPrefix="team">
              <TeamPortalTab />
            </TabPanel>
          )}
        </>
      )}
    </div>
  );
}

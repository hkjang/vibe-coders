import { useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import type { SearchUpdates } from "@/shared/hooks/use-search-state";
import { accountQueryKeys } from "./account-query-keys";
import { validAccountText, type AccountPageState } from "./account-page-model";

export function AccountFilters({
  state,
  update,
}: {
  state: AccountPageState;
  update: (value: SearchUpdates) => void;
}) {
  const { credentialPrefixes } = useAuth();
  const [search, setSearch] = useState(state.search);
  const [role, setRole] = useState(state.role);
  const [status, setStatus] = useState(state.status);
  const [teamMode, setTeamMode] = useState(state.team === "none" ? "none" : state.team ? "id" : "all");
  const [teamId, setTeamId] = useState(state.team.startsWith("id:") ? state.team.slice(3) : "");
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState("");
  const source = JSON.stringify([state.search, state.role, state.status, state.team]);
  const [previousSource, setPreviousSource] = useState(source);
  // Restore Back/Forward state without replacing focused form controls.
  if (source !== previousSource) {
    setPreviousSource(source);
    setSearch(state.search);
    setRole(state.role);
    setStatus(state.status);
    setTeamMode(state.team === "none" ? "none" : state.team ? "id" : "all");
    setTeamId(state.team.startsWith("id:") ? state.team.slice(3) : "");
    setError("");
    setErrorField("");
  }
  const form = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={form}
      aria-label="로그인 계정 필터"
      className="account-page-filters"
      onSubmit={(event) => {
        event.preventDefault();
        const values = [
          ["account-search", search.trim(), 200],
          ["account-role", role.trim(), 256],
          ["account-team", teamMode === "id" ? teamId.trim() : "", 256],
        ] as const;
        const invalid = values.find(([, value, max]) => !validAccountText(value, credentialPrefixes, max));
        if (invalid || (teamMode === "id" && !teamId.trim())) {
          setErrorField(invalid?.[0] ?? "account-team");
          setError(
            "검색은 200자, 역할·팀 코드는 256바이트 이내로 입력하세요. 비밀값과 제어 문자는 사용할 수 없습니다. 팀 지정 시 팀 ID가 필요합니다.",
          );
          form.current
            ?.querySelector<HTMLInputElement>(`[name="${invalid?.[0] ?? "account-team"}"]`)
            ?.focus();
          return;
        }
        setError("");
        update({
          account_q: search.trim(),
          account_role: role.trim(),
          account_status: status,
          account_team: teamMode === "none" ? "none" : teamMode === "id" ? "id:" + teamId.trim() : undefined,
          account_page: undefined,
        });
      }}
    >
      <FormField
        label="계정 검색"
        description="이메일, 이름, 계정 ID, 역할 또는 팀 이름"
        error={errorField === "account-search" ? error : undefined}
      >
        {(control) => (
          <Input
            {...control}
            name="account-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="계정 상태">
        {(control) => (
          <Select {...control} value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">전체 상태</option>
            <option value="active">사용</option>
            <option value="suspended">정지</option>
          </Select>
        )}
      </FormField>
      <FormField
        label="역할 코드"
        description="예: developer · 비우면 전체 역할"
        error={errorField === "account-role" ? error : undefined}
      >
        {(control) => (
          <Input
            {...control}
            name="account-role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="소속 팀">
        {(control) => (
          <Select {...control} value={teamMode} onChange={(event) => setTeamMode(event.target.value)}>
            <option value="all">조회 가능한 전체 팀</option>
            <option value="none">팀 미지정</option>
            <option value="id">팀 ID 지정</option>
          </Select>
        )}
      </FormField>
      {teamMode === "id" ? (
        <FormField label="팀 ID" required error={errorField === "account-team" ? error : undefined}>
          {(control) => (
            <Input
              {...control}
              name="account-team"
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
            />
          )}
        </FormField>
      ) : null}
      <div className="table-actions">
        <Button type="submit" variant="primary">
          필터 적용
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setSearch("");
            setRole("");
            setStatus("");
            setTeamMode("all");
            setTeamId("");
            setError("");
            update(
              Object.fromEntries(
                accountQueryKeys.filter((key) => key !== "account_size").map((key) => [key, undefined]),
              ),
            );
          }}
        >
          필터 초기화
        </Button>
      </div>
    </form>
  );
}

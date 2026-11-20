import { useState, type RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { managedRoleLabel } from "@/config/ui-labels";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { ExpandableCellText } from "@/shared/data-table/ExpandableCellText";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import {
  permissionLabels as labels,
  sessionPermissionRows,
  type PermissionFilter,
} from "./session-permissions";
import "./session-permissions.css";

const modeLabels = { session: "사용자 로그인", legacy_token: "기존 관리자 토큰", open: "개방 모드" };

export default function SessionPermissionsDialog({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const auth = useAuth();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<PermissionFilter>("granted");
  const scopes = auth.user?.scopes ?? [];
  const rows = sessionPermissionRows(scopes, search, filter);
  const raw = auth.capabilities?.raw_prompt_view === true;
  return (
    <Dialog
      open
      title={labels.title}
      description={labels.description}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      scrollBody
      footer={<Button onClick={onClose}>닫기</Button>}
    >
      {!auth.user ? (
        <p role="status">{labels.unavailable}</p>
      ) : (
        <div className="session-permissions">
          <dl className="session-permission-identity">
            <div>
              <dt>역할</dt>
              <dd>{managedRoleLabel(auth.user.role)}</dd>
            </div>
            <div>
              <dt>팀</dt>
              <dd>
                <ExpandableCellText value={auth.user.team_id || "지정되지 않음"} />
              </dd>
            </div>
            <div>
              <dt>인증 방식</dt>
              <dd>{modeLabels[auth.authenticationMode]}</dd>
            </div>
          </dl>
          <div className="session-permission-boundary">
            <p>{labels.boundary}</p>
            <p>{auth.authenticationMode === "session" ? labels.refresh : labels.shared}</p>
          </div>
          <section className="session-permission-raw" aria-label={labels.rawTitle}>
            <div>
              <h2>{labels.rawTitle}</h2>
              <Badge tone={raw ? "success" : "muted"}>{raw ? "허용됨" : "제한됨"}</Badge>
            </div>
            <p>{labels.rawDescription}</p>
          </section>
          <div className="session-permission-filters">
            <label>
              {labels.search}
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="한글 이름 또는 권한 코드"
              />
            </label>
            <label>
              {labels.filter}
              <Select value={filter} onChange={(event) => setFilter(event.target.value as PermissionFilter)}>
                <option value="all">{labels.all}</option>
                <option value="granted">{labels.granted}</option>
                <option value="missing">{labels.missing}</option>
              </Select>
            </label>
          </div>
          <p role="status">
            부여된 권한 {new Set(scopes).size}개 · 표시 {rows.length}개
          </p>
          {!scopes.length ? <p>{labels.noGrants}</p> : null}
          {rows.length ? (
            <ul className="session-permission-list" aria-label="세션 권한 목록">
              {rows.map((row) => (
                <li key={row.value}>
                  <div>
                    <strong>{row.label}</strong>
                    <code>{row.value}</code>
                    <p>{row.description}</p>
                  </div>
                  <Badge tone={row.granted ? "success" : "muted"}>
                    {row.granted ? labels.granted : labels.missing}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p>{labels.empty}</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

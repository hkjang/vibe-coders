import { Plus, Trash2 } from "lucide-react";

import type { SsoRoleRow } from "@/features/system/settings/use-sso-draft";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";

export function SsoRoleMapEditor({
  rows,
  roleOptions,
  onChange,
  onReset,
}: {
  rows: SsoRoleRow[];
  roleOptions: ReadonlyArray<{ value: string; label: string }>;
  onChange: (rows: SsoRoleRow[]) => void;
  onReset: (trigger: HTMLButtonElement) => void;
}): React.JSX.Element {
  return (
    <fieldset className="settings-fieldset">
      <legend>역할 매핑 (Keycloak 역할 → 내부 역할)</legend>
      <div className="data-table-scroll" role="region" aria-label="Keycloak 역할 매핑" tabIndex={0}>
        <table className="data-table">
          <caption className="sr-only">Keycloak 역할 매핑</caption>
          <thead>
            <tr>
              <th scope="col">Keycloak 역할</th>
              <th scope="col">내부 역할</th>
              <th scope="col">작업</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="data-table-state">
                  매핑이 없습니다. 행을 추가하면 Keycloak 역할을 내부 역할로 연결할 수 있습니다.
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={index}>
                  <td>
                    <Input
                      aria-label={`${index + 1}번 Keycloak 역할`}
                      value={row.keycloakRole}
                      onChange={(event) =>
                        onChange(
                          rows.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, keycloakRole: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <Select
                      aria-label={`${index + 1}번 내부 역할`}
                      value={row.internalRole}
                      onChange={(event) =>
                        onChange(
                          rows.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, internalRole: event.target.value } : item,
                          ),
                        )
                      }
                    >
                      <option value="">선택 안 함</option>
                      {roleOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Button
                      size="small"
                      variant="ghost"
                      aria-label={`${row.keycloakRole || `${index + 1}번`} 매핑 삭제`}
                      onClick={() => onChange(rows.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      <Trash2 aria-hidden="true" /> 삭제
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="settings-form-actions">
        <Button size="small" onClick={() => onChange([...rows, { keycloakRole: "", internalRole: "" }])}>
          <Plus aria-hidden="true" /> 행 추가
        </Button>
        <Button size="small" onClick={(event) => onReset(event.currentTarget)}>
          매핑을 기본값으로 초기화
        </Button>
      </div>
    </fieldset>
  );
}

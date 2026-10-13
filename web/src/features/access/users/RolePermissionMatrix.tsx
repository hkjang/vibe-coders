import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { managedRoleLabel } from "@/config/ui-labels";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatDateTime } from "@/shared/utils/format";
import { accessKeys } from "./use-access-admin";
import { matrixRows, roleMatrixEndpoint, type RoleMatrixCatalog } from "./role-permission-matrix";
import "./role-permission-matrix.css";

function Matrix({ catalog }: { catalog: RoleMatrixCatalog }): React.JSX.Element {
  const [selection, setSelection] = useState(() => [
    catalog.roles[0]?.role ?? "",
    catalog.roles[1]?.role ?? "",
    "",
    "",
  ]);
  const [search, setSearch] = useState("");
  const [differences, setDifferences] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const selected = selection.filter(Boolean);
  const rows = matrixRows(catalog, selected, search, differences);
  return (
    <div className="role-matrix">
      <div className="role-matrix-selectors">
        {selection.map((value, index) => (
          <label key={index}>
            비교 역할 {index + 1}
            <Select
              value={value}
              onChange={(event) =>
                setSelection((current) =>
                  current.map((item, slot) => (slot === index ? event.target.value : item)),
                )
              }
            >
              <option value="">선택하지 않음</option>
              {catalog.roles
                .filter((role) => role.role === value || !selected.includes(role.role))
                .map((role) => (
                  <option key={role.role} value={role.role}>
                    {managedRoleLabel(role.role)} ({role.role})
                  </option>
                ))}
            </Select>
          </label>
        ))}
      </div>
      <label>
        권한 검색
        <Input
          ref={searchInput}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="한글 이름 또는 권한 코드"
        />
      </label>
      <Checkbox
        label="차이가 있는 권한만"
        checked={differences}
        onChange={(event) => setDifferences(event.target.checked)}
      />
      <Button
        onClick={() => {
          setSearch("");
          setDifferences(false);
          searchInput.current?.focus();
        }}
      >
        검색·필터 초기화
      </Button>
      <p role="status">
        선택한 역할 {selected.length}개 · 표시 권한 {rows.length}개
      </p>
      {selected.length < 2 ? (
        <p>비교할 역할을 두 개 이상 선택하세요.</p>
      ) : rows.length === 0 ? (
        <p>
          {differences
            ? "현재 검색 조건에서 차이가 있는 권한이 없습니다."
            : "현재 검색 조건에 맞는 권한이 없습니다."}
        </p>
      ) : (
        <div
          className="role-matrix-scroll"
          role="region"
          aria-label="역할별 권한 비교 표, 가로 스크롤 가능"
          tabIndex={0}
        >
          <table>
            <caption>서버에 등록된 역할별 권한 비교</caption>
            <thead>
              <tr>
                <th scope="col">권한</th>
                {selected.map((role) => (
                  <th scope="col" key={role}>
                    {managedRoleLabel(role)}
                    <small>{role}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.scope}>
                  <th scope="row">
                    {row.title}
                    <small>{row.scope}</small>
                    {!row.registered ? <small>현재 권한 목록에 없음</small> : null}
                  </th>
                  {row.grants.map((grant, index) => (
                    <td key={selected[index]}>{grant ? "부여됨" : "미부여"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Read-only, independently fresh catalog; no access decisions are inferred. */
export function RolePermissionMatrix({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}): React.JSX.Element | null {
  const auth = useAuth();
  const owner = useFeatureReadOwner("access.users", "role-permission-matrix");
  const [initialOwner] = useState(owner.id);
  const current = owner.id === initialOwner && owner.readable && !owner.denied;
  useLayoutEffect(() => {
    if (!current) onClose();
  }, [current, onClose]);
  const catalog = useQuery({
    queryKey: featureOwnedKey([...accessKeys.roles, "matrix"], owner),
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(roleMatrixEndpoint, { signal, routeId: "access.users" });
      assertFeatureRead(owner, signal);
      const identifiers = [
        ...data.all_scopes,
        ...data.roles.flatMap((role) => [role.role, ...(role.scopes ?? [])]),
      ];
      if (identifiers.some((value) => containsPotentialSecret(value, auth.credentialPrefixes)))
        throw new AppError("역할 목록을 확인하지 못했습니다.", { kind: "contract" });
      return data;
    },
    enabled: current,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (!current) return null;
  const ready = catalog.isSuccess && catalog.fetchStatus === "idle";
  return (
    <Dialog
      open
      scrollBody
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title="역할별 권한 비교"
      description="최대 네 역할의 등록된 권한을 비교합니다. 사용자·팀·자원별 정책과 세션의 유효 권한은 별도로 적용되므로 실제 접근 허용을 보장하지 않습니다."
      footer={
        <>
          <Button disabled={catalog.isFetching} onClick={() => void catalog.refetch()}>
            목록 새로 조회
          </Button>
          <Button onClick={onClose}>닫기</Button>
        </>
      }
    >
      <p>새로 조회하면 비교 선택과 검색 조건을 초기화합니다. 조회만 수행하며 역할을 변경하지 않습니다.</p>
      {catalog.isError ? (
        <InlineNotice tone="warning">역할 목록을 확인하지 못했습니다. 목록을 다시 조회하세요.</InlineNotice>
      ) : !ready ? (
        <p role="status">역할 목록을 확인하고 있습니다.</p>
      ) : (
        <>
          <p>마지막 조회 {formatDateTime(catalog.dataUpdatedAt)}</p>
          <Matrix key={catalog.dataUpdatedAt} catalog={catalog.data} />
        </>
      )}
    </Dialog>
  );
}

import { useCallback, useRef, useState } from "react";

import { ProviderFormDialog, ProviderSloDialog } from "@/features/gateway/providers/ProviderAdminDialogs";
import { ProviderDeleteDialog } from "@/features/gateway/providers/ProviderDeleteDialog";
import type { ProviderCatalogRow } from "@/features/gateway/providers/provider-catalog";
import { useProviderAdmin } from "@/features/gateway/providers/use-provider-admin";
import { Button } from "@/shared/components/ui/Button";

export function useProviderAdministration(canWrite: boolean, credentialPrefixes: readonly string[]) {
  const admin = useProviderAdmin();
  const savePending = admin.save.isPending;
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const adminReturnFocusRef = useRef<HTMLElement | null>(null);
  const returnAction = useRef<{ identity: string; action: string } | undefined>(undefined);
  const [editing, setEditing] = useState<
    { row?: ProviderCatalogRow; initialEnabled?: boolean } | undefined
  >();
  const [sloEditing, setSloEditing] = useState<ProviderCatalogRow | undefined>();
  const [removing, setRemoving] = useState<ProviderCatalogRow | undefined>();
  const writeDeniedReason = canWrite ? undefined : "공급자 변경은 admin:write 권한이 필요합니다.";
  // Deleting a provider and editing its SLO key on an identifier the server resolves,
  // so the opaque reference works for a provider whose name is redacted. Saving the
  // provider itself is an upsert on the name, which a redacted row cannot supply.
  const redactedSaveReason = "공급자 이름이 비공개 처리되어 연결 설정은 기존 화면에서 변경합니다.";

  const rememberAdminTrigger = (
    event: React.MouseEvent<HTMLButtonElement>,
    identity: string,
    action: string,
  ): void => {
    returnAction.current = { identity, action };
    adminReturnFocusRef.current = event.currentTarget;
  };
  const rememberMountedTrigger = (node: HTMLButtonElement | null, identity: string, action: string): void => {
    // Refetching rows or changing pending state can replace a table cell. Follow
    // only the same provider/action's current DOM node, never another row. If the
    // row disappears, Dialog deliberately falls back to the main-content target.
    if (node && returnAction.current?.identity === identity && returnAction.current.action === action)
      adminReturnFocusRef.current = node;
  };
  const renderRowActions = useCallback(
    (row: ProviderCatalogRow): React.JSX.Element => {
      const blocked = writeDeniedReason;
      const saveBlocked = blocked ?? (row.nameRedacted ? redactedSaveReason : undefined);
      return (
        <>
          <Button
            ref={(node) => rememberMountedTrigger(node, row.identity, "edit")}
            size="small"
            variant="ghost"
            disabled={saveBlocked !== undefined}
            title={saveBlocked}
            onClick={(event) => {
              rememberAdminTrigger(event, row.identity, "edit");
              setEditing({ row });
            }}
          >
            수정
          </Button>
          <Button
            ref={(node) => rememberMountedTrigger(node, row.identity, "toggle")}
            size="small"
            variant="ghost"
            disabled={saveBlocked !== undefined || savePending}
            title={saveBlocked}
            onClick={(event) => {
              rememberAdminTrigger(event, row.identity, "toggle");
              setEditing({ row, initialEnabled: !row.provider.enabled });
            }}
          >
            {row.provider.enabled ? "중지" : "사용"}
          </Button>
          <Button
            ref={(node) => rememberMountedTrigger(node, row.identity, "slo")}
            size="small"
            variant="ghost"
            disabled={blocked !== undefined}
            title={blocked}
            onClick={(event) => {
              rememberAdminTrigger(event, row.identity, "slo");
              setSloEditing(row);
            }}
          >
            SLO
          </Button>
          <Button
            ref={(node) => rememberMountedTrigger(node, row.identity, "delete")}
            size="small"
            variant="ghost"
            disabled={blocked !== undefined}
            title={blocked}
            onClick={(event) => {
              rememberAdminTrigger(event, row.identity, "delete");
              setRemoving(row);
            }}
          >
            삭제
          </Button>
        </>
      );
    },
    [savePending, redactedSaveReason, writeDeniedReason],
  );

  const openCreate = (): void => {
    returnAction.current = undefined;
    adminReturnFocusRef.current = createButtonRef.current;
    setEditing({});
  };
  const dialogs = (
    <>
      <ProviderFormDialog
        credentialPrefixes={credentialPrefixes}
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
        returnFocusRef={adminReturnFocusRef}
        row={editing?.row}
        initialEnabled={editing?.initialEnabled}
        onSubmit={(body) => admin.save.mutateAsync(body)}
      />

      <ProviderSloDialog
        open={sloEditing !== undefined}
        onOpenChange={(open) => {
          if (!open) setSloEditing(undefined);
        }}
        returnFocusRef={adminReturnFocusRef}
        row={sloEditing}
        onSubmit={(body) => admin.saveSlo.mutateAsync(body)}
      />

      {removing ? (
        <ProviderDeleteDialog
          key={removing.identity}
          row={removing}
          credentialPrefixes={credentialPrefixes}
          onOpenChange={(open) => {
            if (!open) setRemoving(undefined);
          }}
          returnFocusRef={adminReturnFocusRef}
          onDelete={(identifier) => admin.remove.mutateAsync(identifier)}
        />
      ) : null}
    </>
  );
  return { createButtonRef, openCreate, renderRowActions, dialogs, writeDeniedReason };
}

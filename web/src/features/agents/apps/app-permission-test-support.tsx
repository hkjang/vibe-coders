/* eslint-disable react-refresh/only-export-components -- Test-only render helpers are not application modules. */
import { screen, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";

import { AppDetailSheet } from "./AppDetailSheet";
import { appPermissionKey } from "./app-permission-form";
import type { AppPermission, WorkApp } from "@/shared/api/domains/agents.schemas";
import { mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

export const app: WorkApp = { id: "app_review", title: "검토 도우미", status: "active", components: [] };
export const row: AppPermission = {
  id: "permission_one",
  subject_type: "user",
  subject_id: "user_one",
  granted_by: "admin_fixture",
};
export const path = `/admin/apps/${app.id}/permissions`;
export const permissionKey = appPermissionKey(app.id);

function Host({ writable = true }: { writable?: boolean }) {
  const [selected, setSelected] = useState<WorkApp>(app);
  const [canWrite, setCanWrite] = useState(writable);
  const [open, setOpen] = useState(true);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <main id="main-content" tabIndex={-1}>
      <button ref={trigger} onClick={() => setOpen(true)}>
        상세 열기
      </button>
      <button onClick={() => setCanWrite(false)}>쓰기 권한 제거</button>
      <button onClick={() => setSelected({ ...app, id: "other_app", title: "다른 앱" })}>외부 앱 변경</button>
      <AppDetailSheet
        app={selected}
        canWrite={canWrite}
        open={open}
        returnFocusRef={trigger}
        onOpenChange={setOpen}
        onDelete={() => undefined}
        onDeprecate={() => undefined}
        onEdit={() => undefined}
        onPublish={() => undefined}
        onRun={() => undefined}
        onValidate={() => undefined}
        runError={null}
        runPending={false}
        runPlan={undefined}
        validation={undefined}
        validationError={null}
        validationPending={false}
        writeDisabledReason="앱 변경에는 admin:write 권한이 필요합니다."
      />
    </main>
  );
}

export function setup({
  load = () => ({ permissions: [row] }),
  grant = () => ({ ok: true }),
  revoke = () => ({ ok: true }),
  writable = true,
}: {
  load?: ApiHandler;
  grant?: ApiHandler;
  revoke?: ApiHandler;
  writable?: boolean;
} = {}) {
  const api = mockApi({
    [`GET ${path}`]: load,
    [`POST ${path}`]: grant,
    [`DELETE ${path}`]: revoke,
    "GET /admin/apps/other_app/permissions": () => ({ permissions: [] }),
  });
  return { api, ...renderScreen(<Host writable={writable} />) };
}

export async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "권한 관리" }));
  return await screen.findByRole("button", { name: "접근 권한 추가" });
}
export async function openGrant(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await openPanel(user));
  return screen.findByRole("dialog", { name: "앱 접근 권한 추가" });
}
export function dialogForm(dialog: HTMLElement) {
  const form = dialog.querySelector("form");
  if (!form) throw new Error("missing permission form");
  return form;
}
export async function fillGrant(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  value = "user_two",
) {
  await user.type(within(dialog).getByRole("textbox", { name: "사용자 ID" }), value);
}
export function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

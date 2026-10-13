import { expect, type Request } from "@playwright/test";

import {
  accessPath,
  closeSecret,
  confirmKeyEdit,
  editScopes,
  issueKey,
  keyRow,
  keysPath,
  matches,
  prepareIssue,
  protectedChat,
  publicKeyCheck,
  saveScopes,
  scopeTitle,
  secretIsAbsent,
  watchLateAccessReads,
  type IssuedKey,
} from "./access-fixture";
import {
  admin,
  currentRole,
  login,
  reader,
  required,
  sessionIsEmpty,
  signIn,
  signOut,
  test,
} from "./live-fixture";

test("AUTH-LIVE-028 실제 팀 생성·중복 방지·이름 수정과 팀 관리자 범위", async ({ page }) => {
  const superAdmin = {
    email: required("VIBE_AUTH_SUPER_EMAIL"),
    password: required("VIBE_AUTH_SUPER_PASSWORD"),
  };
  const teamName = "브라우저 검증 팀";
  await login(page, superAdmin, "/app/access/users?tab=teams");
  // The existing API permits long opaque IDs. Seed through the actual API, then edit in the UI.
  const longId = `legacy_team_${"x".repeat(1024)}`;
  expect(
    await page.evaluate(async (id) => {
      const response = await fetch("/admin/teams", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
        },
        body: JSON.stringify({ id, name: "긴 ID 기존 팀" }),
      });
      return response.status;
    }, longId),
  ).toBe(201);
  await page.reload();
  const longRow = page
    .getByRole("table", { name: "등록된 팀 목록", exact: true })
    .getByRole("row")
    .filter({ hasText: "긴 ID 기존 팀" });
  await longRow.getByRole("button", { name: "이름 수정" }).click();
  const longEditor = page.getByRole("dialog", { name: "팀 이름 수정" });
  await expect(longEditor.getByRole("textbox", { name: "팀 ID", exact: true })).toHaveValue(longId);
  await longEditor.getByRole("textbox", { name: "팀 이름", exact: true }).fill("긴 ID 호환 수정");
  await longEditor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(longEditor).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: "긴 ID 호환 수정" })).toContainText(longId);
  await page.getByRole("button", { name: "팀 추가", exact: true }).click();
  const create = page.getByRole("dialog", { name: "팀 추가", exact: true });
  const teamId = await create.getByRole("textbox", { name: "팀 ID", exact: true }).inputValue();
  expect(/^team_[a-f0-9]{32}$/u.test(teamId)).toBe(true);
  await create.getByRole("textbox", { name: "팀 이름", exact: true }).fill(teamName);
  await create.getByRole("button", { name: "저장", exact: true }).click();
  await expect(create).toBeHidden();
  const table = page.getByRole("table", { name: "등록된 팀 목록", exact: true });
  const row = table.getByRole("row").filter({ hasText: teamId });
  await expect(row).toContainText(teamName);
  await page.getByRole("button", { name: "팀 추가", exact: true }).click();
  await create.getByRole("textbox", { name: "팀 ID", exact: true }).fill(teamId);
  await create.getByRole("textbox", { name: "팀 이름", exact: true }).fill("덮어쓰면 안 되는 이름");
  let writes = 0;
  const countWrite = (request: Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/admin/teams") writes++;
  };
  page.on("request", countWrite);
  await create.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    create.getByText("이미 등록된 팀 ID입니다. 목록의 이름 수정 기능을 이용하세요."),
  ).toBeVisible();
  expect(writes).toBe(0);
  page.off("request", countWrite);
  await create.getByRole("button", { name: "취소", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "변경 버리기" }).click();
  await row.getByRole("button", { name: "이름 수정" }).click();
  const edit = page.getByRole("dialog", { name: "팀 이름 수정" });
  await expect(edit.getByRole("textbox", { name: "팀 ID", exact: true })).toHaveAttribute("readonly");
  await edit.getByRole("textbox", { name: "팀 이름", exact: true }).fill("브라우저 팀 수정");
  await edit.getByRole("button", { name: "저장", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText("브라우저 팀 수정");
  const account = {
    email: "browser-team-admin@example.invalid",
    password: `Synthetic-${crypto.randomUUID()}`,
  };
  await page.getByRole("tab", { name: "사용자", exact: true }).click();
  await page.getByRole("button", { name: "사용자 등록", exact: true }).click();
  const user = page.getByRole("dialog", { name: "사용자 등록" });
  await user.getByRole("textbox", { name: "이메일", exact: true }).fill(account.email);
  await user.getByLabel("비밀번호", { exact: false }).fill(account.password);
  await user.getByRole("combobox", { name: "역할", exact: true }).selectOption("team_admin");
  await user.getByRole("textbox", { name: "팀", exact: true }).fill(teamId);
  await user.getByRole("button", { name: "등록", exact: true }).click();
  await expect(user).toBeHidden();
  await signOut(page);
  await login(page, account, "/app/access/users?tab=teams");
  await expect(page.getByRole("button", { name: "팀 추가", exact: true })).toBeDisabled();
  await expect(table.getByRole("row")).toHaveCount(2);
  await row.getByRole("button", { name: "이름 수정" }).click();
  await edit.getByRole("textbox", { name: "팀 이름", exact: true }).fill("소속 팀 이름 수정");
  await edit.getByRole("button", { name: "저장", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText("소속 팀 이름 수정");
});

test("AUTH-LIVE-027 실제 사용자 정의 역할 등록·계정 부여·유지·변경", async ({ page }) => {
  const superAdmin = {
    email: required("VIBE_AUTH_SUPER_EMAIL"),
    password: required("VIBE_AUTH_SUPER_PASSWORD"),
  };
  const role = "browser_account_custom_role";
  const email = "browser-custom-account@example.invalid";
  const password = `Synthetic-${crypto.randomUUID()}`;
  await login(page, superAdmin, "/app/access/users?tab=roles");
  await page.getByRole("button", { name: "역할 추가", exact: true }).click();
  const roleDialog = page.getByRole("dialog", { name: "역할 추가", exact: true });
  await roleDialog.getByRole("textbox", { name: "역할 이름", exact: true }).fill(role);
  await roleDialog.getByRole("checkbox", { name: "모델 조회 (models:read)", exact: true }).check();
  const roleReview = roleDialog.getByRole("region", { name: "역할 변경 전후 비교", exact: true });
  await expect(roleReview.getByText("권한 추가 1개 · 제거 0개")).toBeVisible();
  await expect(roleReview.getByRole("row", { name: "모델 조회 (models:read) 미부여 부여됨" })).toBeVisible();
  const roleSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/admin/roles",
  );
  await roleDialog.getByRole("button", { name: "저장", exact: true }).click();
  expect((await roleSaved).status()).toBe(201);
  await expect(roleDialog).toBeHidden();
  let duplicateRoleWrites = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/admin/roles")
      duplicateRoleWrites++;
  });
  await page.getByRole("button", { name: "역할 추가", exact: true }).click();
  await roleDialog.getByRole("textbox", { name: "역할 이름", exact: true }).fill(role);
  await roleDialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    roleDialog.getByText("이미 등록된 역할 이름입니다. 목록의 수정 기능을 이용하세요."),
  ).toBeVisible();
  expect(duplicateRoleWrites).toBe(0);
  await roleDialog.getByRole("button", { name: "취소", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "변경 버리기", exact: true }).click();
  await expect(roleDialog).toBeHidden();
  // Compare the newly persisted custom role through the real roles API before
  // assigning it. Displayed grants are not a substitute for auth/me below.
  await page.getByRole("button", { name: "권한 비교", exact: true }).click();
  const matrix = page.getByRole("dialog", { name: "역할별 권한 비교", exact: true });
  await matrix.getByRole("combobox", { name: "비교 역할 1", exact: true }).selectOption(role);
  await matrix.getByRole("combobox", { name: "비교 역할 2", exact: true }).selectOption("developer");
  await expect(
    matrix
      .getByRole("row", { name: /models:read/ })
      .getByRole("cell")
      .first(),
  ).toHaveText("부여됨");
  await expect(
    matrix
      .getByRole("row", { name: /admin:write/ })
      .getByRole("cell")
      .first(),
  ).toHaveText("미부여");
  await matrix.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(matrix).toBeHidden();
  await page.getByRole("tab", { name: "사용자", exact: true }).click();
  await page.getByRole("button", { name: "사용자 등록", exact: true }).click();
  const create = page.getByRole("dialog", { name: "사용자 등록", exact: true });
  await create.getByRole("textbox", { name: "이메일", exact: true }).fill(email);
  await create.getByLabel("비밀번호", { exact: false }).fill(password);
  await create.getByRole("combobox", { name: "역할", exact: true }).selectOption(role);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/admin/users",
  );
  await create.getByRole("button", { name: "등록", exact: true }).click();
  expect((await created).status()).toBe(201);
  await expect(create).toBeHidden();
  const row = () =>
    page.getByRole("table", { name: "로그인 계정 목록" }).getByRole("row").filter({ hasText: email });
  await expect(row().getByText(role, { exact: true })).toBeVisible();
  await page.reload();
  await row().getByRole("button", { name: "역할·상태 변경", exact: true }).click();
  let edit = page.getByRole("dialog", { name: "사용자 변경", exact: true });
  await expect(edit.getByRole("combobox", { name: "역할", exact: true })).toHaveValue(role);
  const preserved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname.startsWith("/admin/users/usr_"),
  );
  await edit.getByRole("button", { name: "저장", exact: true }).click();
  expect((await preserved).status()).toBe(200);
  await expect(edit).toBeHidden();
  // Keep tokens and the random password inside browser memory; expose only a
  // boolean proving the assigned custom role's effective scope on real login.
  expect(
    await page.evaluate(
      async ({ email, password, role }) => {
        const signedIn = await fetch("/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const tokens: { access_token?: string } = await signedIn.json();
        if (!signedIn.ok || !tokens.access_token) return false;
        const me = await fetch("/auth/me", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
        const current: { user?: { role?: string; scopes?: string[] } } = await me.json();
        return (
          me.ok &&
          current.user?.role === role &&
          JSON.stringify(current.user.scopes) === JSON.stringify(["models:read"])
        );
      },
      { email, password, role },
    ),
  ).toBe(true);
  await row().getByRole("button", { name: "역할·상태 변경", exact: true }).click();
  edit = page.getByRole("dialog", { name: "사용자 변경", exact: true });
  await edit.getByRole("combobox", { name: "역할", exact: true }).selectOption("viewer");
  const changed = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname.startsWith("/admin/users/usr_"),
  );
  await edit.getByRole("button", { name: "저장", exact: true }).click();
  expect((await changed).status()).toBe(200);
  await expect(edit).toBeHidden();
  await page.reload();
  await expect(row().getByText("조회자", { exact: true })).toBeVisible();
});

test("AUTH-LIVE-012 실제 Text2SQL 중지·재개와 읽기 전용 서버 거부", async ({ page }) => {
  const path = "/admin/text2sql/kill-switch";
  const entry = (resume: boolean) =>
    page.getByRole("button", { name: `Text2SQL 처리 ${resume ? "재개" : "중지"} 검토`, exact: true });
  await login(page, admin, "/app/text2sql");
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === path) writes++;
  });
  for (const resume of [false, true]) {
    const label = `Text2SQL 처리 ${resume ? "재개" : "중지"}`;
    await expect(entry(resume)).toBeEnabled();
    await entry(resume).click();
    const dialog = page.getByRole("dialog", { name: label, exact: true });
    const confirm = dialog.getByRole("button", { name: resume ? "재개" : "중지", exact: true });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox", { name: "확인 문구", exact: true }).fill(label);
    await expect(confirm).toBeDisabled();
    await dialog
      .getByRole("textbox", { name: "변경 사유", exact: true })
      .fill(resume ? "browser-text2sql-reviewed-resume" : "browser-text2sql-reviewed-stop");
    const pending = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === path,
    );
    await confirm.click();
    const response = await pending;
    expect(response.status()).toBe(200);
    const state: { disabled?: boolean; scope?: string } = await response.json();
    expect(state.disabled === !resume && state.scope === "responding_process").toBe(true);
    await expect(dialog).toBeHidden();
    await expect(entry(!resume)).toBeEnabled();
    expect(writes).toBe(resume ? 2 : 1);
  }
  await page.reload();
  await expect(entry(false)).toBeEnabled();
  await signOut(page);
  await signIn(page, reader);
  await expect(entry(false)).toBeDisabled();
  // Both calls reach the real authenticated server. No route response is
  // fabricated; only status and public control booleans leave browser memory.
  const denied = await page.evaluate(async (endpoint) => {
    const headers = {
      Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      "Content-Type": "application/json",
    };
    const state = await fetch(endpoint, { headers, cache: "no-store" });
    const before: { disabled?: boolean; review_token?: string } = await state.json();
    const write = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        disabled: true,
        reason: "browser-readonly-denied",
        expected_review_token: before.review_token,
      }),
    });
    const current = await fetch(endpoint, { headers, cache: "no-store" });
    const after: { disabled?: boolean } = await current.json();
    return {
      read: state.status,
      write: write.status,
      unchanged: before.disabled === false && after.disabled === false,
    };
  }, path);
  expect(denied).toEqual({ read: 200, write: 401, unchanged: true });
});

// Every request below reaches the actual Go Routes and temporary SQLite DB.
// Delays hold an already-committed real response, never a fabricated success.
test("AUTH-LIVE-006 실제 발급 비밀값 일회 표시와 공개 목록", async ({ page }) => {
  await login(page, admin, accessPath);
  const name = "browser-access-issued-once";
  // No selection on issuance omits scopes; only creation uses role defaults.
  const issued = await issueKey(page, name, []);
  const defaults = [
    "chat:completion",
    "embeddings:create",
    "models:read",
    "routing:read",
    "observability:read",
    "costs:read",
    "mcp:use",
  ];
  expect(JSON.stringify([...issued.api_key.scopes].sort()) === JSON.stringify(defaults.sort())).toBe(true);
  await publicKeyCheck(page, issued.api_key.id, issued.secret, issued.api_key.scopes);
  await closeSecret(page);
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
  await page.reload();
  await expect(keyRow(page, name)).toBeVisible();
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
  await signOut(page);
  expect(await sessionIsEmpty(page)).toBe(true);
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
  await signIn(page);
  await expect(keyRow(page, name)).toBeVisible();
  await publicKeyCheck(page, issued.api_key.id, issued.secret);
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
});

test("AUTH-LIVE-007 실제 권한 저장·전체 해제·보호된 대화 호출 거부와 복구", async ({ page }) => {
  await login(page, admin, accessPath);
  const name = "browser-access-scope-roundtrip";
  const issued = await issueKey(page, name, ["chat:completion", "models:read"]);
  await closeSecret(page);
  expect(await protectedChat(page, issued.secret, "browser-access-model")).toBe(200);
  let dialog = await editScopes(page, name);
  await dialog.getByRole("checkbox", { name: /chat:completion/ }).uncheck();
  await dialog.getByRole("checkbox", { name: /models:read/ }).uncheck();
  await expect(dialog.getByText("현재 선택: 선택된 권한 없음", { exact: true })).toBeVisible();
  await saveScopes(page, dialog, issued.api_key.id, []);
  await publicKeyCheck(page, issued.api_key.id, issued.secret, []);
  // /v1/models allows anonymous reads and cannot prove a scope denial. The
  // harness additionally asserts this denied model NEVER reaches its upstream.
  expect(await protectedChat(page, issued.secret, "browser-access-denied-model")).toBe(401);
  await page.reload();
  await expect(keyRow(page, name).getByText("선택된 권한 없음", { exact: true })).toBeVisible();
  dialog = await editScopes(page, name);
  await expect(dialog.getByRole("checkbox", { name: /chat:completion/ })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: /chat:completion/ }).check();
  await saveScopes(page, dialog, issued.api_key.id, ["chat:completion"]);
  expect(await protectedChat(page, issued.secret, "browser-access-model")).toBe(200);
  await page.reload();
  await expect(keyRow(page, name)).toBeVisible();
  await publicKeyCheck(page, issued.api_key.id, issued.secret, ["chat:completion"]);
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
});

test("AUTH-LIVE-008 읽기 전용 관리자의 UI와 실제 발급·수정 거부", async ({ page }) => {
  await login(page, admin, accessPath);
  const name = "browser-access-readonly-target";
  const issued = await issueKey(page, name, ["models:read"]);
  await closeSecret(page);
  await signOut(page);
  await signIn(page, reader);
  expect(await currentRole(page)).toBe("readonly_admin");
  await expect(page.getByRole("button", { name: "키 발급", exact: true })).toBeDisabled();
  const row = keyRow(page, name);
  await expect(row.getByRole("button", { name: "권한 수정", exact: true })).toBeDisabled();
  await expect(row.getByRole("button", { name: "수정", exact: true })).toBeDisabled();
  await expect(row.getByRole("button", { name: "폐기", exact: true })).toBeDisabled();
  const result = await page.evaluate(async (id) => {
    const headers = {
      Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      "Content-Type": "application/json",
    };
    const before = await fetch("/admin/api-keys", { headers });
    const original = await before.text();
    const created = await fetch("/admin/api-keys", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "browser-access-denied-creation",
        role: "developer",
        scopes: ["models:read"],
      }),
    });
    const updated = await fetch(`/admin/api-keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "browser-access-denied-edit", scopes: [] }),
    });
    const after = await fetch("/admin/api-keys", { headers });
    return {
      read: before.status,
      create: created.status,
      update: updated.status,
      reread: after.status,
      unchanged: original === (await after.text()),
    };
  }, issued.api_key.id);
  expect(result).toEqual({ read: 200, create: 401, update: 401, reread: 200, unchanged: true });
  await publicKeyCheck(page, issued.api_key.id, issued.secret, ["models:read"]);
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
});

test("AUTH-LIVE-009 실제 발급 완료의 늦은 응답과 새 계정 비밀값 격리", async ({ page, context }) => {
  await login(page, admin, accessPath);
  const other = await context.newPage();
  await login(other, admin, accessPath);
  await page.bringToFront();
  const sameDocument = await page.evaluate(() => performance.timeOrigin);
  const name = "browser-access-late-issuance";
  let issued: IssuedKey | undefined;
  let release = (): void => undefined;
  let delivered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/admin/api-keys", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    issued = (await response.json()) as IssuedKey;
    await gate;
    await route.fulfill({ response });
    delivered = true;
  });
  try {
    const dialog = await prepareIssue(page, name, ["chat:completion"]);
    await dialog.getByRole("button", { name: "발급", exact: true }).click();
    await expect.poll(() => Boolean(issued?.secret && issued.api_key.id)).toBe(true);
    await expect(dialog.getByRole("button", { name: "저장 중", exact: true })).toBeDisabled();
    await signOut(other);
    await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
    expect(await sessionIsEmpty(page)).toBe(true);
    await expect(dialog).toBeHidden();
    await signIn(page, reader);
    expect(await currentRole(page)).toBe("readonly_admin");
    await expect(keyRow(page, name)).toBeVisible();
    const staleReads = watchLateAccessReads(page);
    const received = page.waitForResponse((response) => matches(response, "POST", keysPath));
    release();
    try {
      const response = await received;
      expect(response.status()).toBe(201);
      await expect.poll(() => delivered).toBe(true);
      await staleReads.assertSettled(response);
    } finally {
      staleReads.stop();
    }
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(sameDocument);
    expect(Boolean(issued)).toBe(true);
    if (!issued) throw new Error("The actual issuance response was not captured");
    expect(await secretIsAbsent(page, issued.secret)).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "키 발급", exact: true })).toBeDisabled();
    expect(await currentRole(page)).toBe("readonly_admin");
    // The server already committed the key. Seeing its public row is allowed;
    // client session isolation does not cancel or roll back that write.
    await expect(keyRow(page, name)).toBeVisible();
    await publicKeyCheck(page, issued.api_key.id, issued.secret, ["chat:completion"]);
  } finally {
    release();
  }
});

test("AUTH-LIVE-010 실제 권한 저장 완료의 늦은 응답과 이전 계정 초안 폐기", async ({ page, context }) => {
  await login(page, admin, accessPath);
  const name = "browser-access-late-scope-update";
  const issued = await issueKey(page, name, ["models:read"]);
  await closeSecret(page);
  const other = await context.newPage();
  await login(other, admin, accessPath);
  await page.bringToFront();
  const sameDocument = await page.evaluate(() => performance.timeOrigin);
  let ready = false;
  let delivered = false;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const path = `${keysPath}/${issued.api_key.id}`;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const body: { scopes?: string[] } = route.request().postDataJSON();
    expect(JSON.stringify(body.scopes) === JSON.stringify(["chat:completion", "models:read"])).toBe(true);
    ready = true;
    await gate;
    await route.fulfill({ response });
    delivered = true;
  });
  try {
    const dialog = await editScopes(page, name);
    await dialog.getByRole("checkbox", { name: /chat:completion/ }).check();
    await confirmKeyEdit(dialog, "browser-reviewed-scopes-late");
    await dialog.getByRole("button", { name: "권한 저장", exact: true }).click();
    await expect.poll(() => ready).toBe(true);
    await expect(dialog.getByRole("checkbox", { name: /chat:completion/ })).toBeDisabled();
    await signOut(other);
    await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
    expect(await sessionIsEmpty(page)).toBe(true);
    await expect(page.getByRole("dialog", { name: scopeTitle, exact: true })).toBeHidden();
    await signIn(page, reader);
    expect(await currentRole(page)).toBe("readonly_admin");
    await expect(keyRow(page, name)).toBeVisible();
    const staleReads = watchLateAccessReads(page);
    const received = page.waitForResponse((response) => matches(response, "PATCH", path));
    release();
    try {
      const response = await received;
      expect(response.status()).toBe(200);
      await expect.poll(() => delivered).toBe(true);
      await staleReads.assertSettled(response);
    } finally {
      staleReads.stop();
    }
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(sameDocument);
    expect(await secretIsAbsent(page, issued.secret)).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await expect(keyRow(page, name).getByRole("button", { name: "권한 수정", exact: true })).toBeDisabled();
    expect(await currentRole(page)).toBe("readonly_admin");
    // The write completed at Go before logout. Only its old-client continuation
    // is discarded; the readonly account may legitimately read committed scopes.
    await publicKeyCheck(page, issued.api_key.id, issued.secret, ["chat:completion", "models:read"]);
  } finally {
    release();
  }
});

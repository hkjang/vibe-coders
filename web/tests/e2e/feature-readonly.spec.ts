import { expect, type Locator, type Page } from "@playwright/test";
import {
  firstEmail,
  secondEmail,
  llmUrl,
  xviewUrl,
  skillUrl,
  skillName,
  requestId,
  viewId,
  reason,
  test,
  type FeatureId,
} from "../fixtures/feature-readonly-gateway";

// Tests the real FeatureRoute with synthetic bootstrap/API responses, not server
// authorization. Missing/wrong owner and stale callbacks are separate unit proof.
const draft = "읽기 전용 전환 전 공개 초안";
const skillSheet = (page: Page) =>
  page.getByRole("dialog", { name: skillName, exact: true, includeHidden: true });
const fitness = (page: Page) => page.getByRole("dialog", { name: "스킬 적합성 근거 기록", exact: true });
const note = (page: Page) => page.getByRole("dialog", { name: "요청 메모·태그 수정", exact: true });
const noteCard = (page: Page) =>
  page
    .getByRole("heading", { name: "운영 메모·태그", exact: true, includeHidden: true })
    .locator("xpath=ancestor::section[1]");
const views = (page: Page) => page.getByRole("group", { name: "저장된 뷰", exact: true });
const guard = (page: Page) => page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
async function signIn(page: Page, email = firstEmail) {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
}
async function login(page: Page, path = skillUrl, email = firstEmail) {
  await page.goto(`login?return_to=${encodeURIComponent(path)}`);
  await signIn(page, email);
  const refresh = page.getByLabel("자동 새로고침 간격");
  if (await refresh.isVisible()) await refresh.selectOption("0");
}
async function refreshRuntime(page: Page) {
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function showSkill(page: Page) {
  await page.getByRole("button", { name: `${skillName} 상세 열기`, exact: true }).click();
}
async function showFitness(page: Page) {
  await showSkill(page);
  await skillSheet(page).getByRole("button", { name: "적합성 근거", exact: true }).click();
  await expect(skillSheet(page).getByRole("button", { name: "근거 기록", exact: true })).toBeEnabled();
  await skillSheet(page).getByRole("button", { name: "근거 기록", exact: true }).click();
}
async function showInsight(page: Page, id: "observability.llm" | "observability.xview") {
  if (id === "observability.llm") {
    await page.getByRole("button", { name: `${requestId} 호출 상세 열기`, exact: true }).click();
    await page.getByRole("button", { name: "원인 설명 열기", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "최근 25건 선택", exact: true }).click();
    await page.getByRole("button", { name: `${requestId} 원인 설명 열기`, exact: true }).click();
  }
  await expect(noteCard(page)).toBeVisible();
}
async function submitDirectly(dialog: Locator) {
  await dialog.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
}
async function noOverflow(page: Page, dialog: Locator) {
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function axe(page: Page) {
  return page.evaluate(async () => {
    const api = (
      window as unknown as {
        axe: { run: (root: Document) => Promise<{ violations: { id: string; impact: string | null }[] }> };
      }
    ).axe;
    return (await api.run(document)).violations.map(({ id, impact }) => ({ id, impact }));
  });
}

for (const mode of ["read_only", "preview_read_only"] as const) {
  test(`스킬 ${mode}는 쓰기 권한을 유지해도 저장을 막고 조회·순수 POST 계산을 허용한다`, async ({
    page,
    gateway,
  }) => {
    gateway.setMode("agents.skills", mode);
    await login(page);
    await expect(page.getByRole("button", { name: "스킬 추가", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "추천 스킬 추가", exact: true })).toBeDisabled();
    await expect(page.getByLabel("가져오기", { exact: true })).toBeDisabled();
    await expect(page.getByText(reason, { exact: false }).first()).toBeVisible();
    await page.getByRole("button", { name: "보안 스캔", exact: true }).click();
    await expect.poll(() => gateway.count("GET /admin/skills/scan")).toBe(1);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "내보내기", exact: true }).click();
    await download;
    expect(gateway.count("GET /admin/skills/export")).toBe(1);
    await page.getByRole("button", { name: "스킬 추천", exact: true }).click();
    await expect(page.getByText("순수 추천 계산 결과", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "초안으로 적용", exact: true })).toBeDisabled();
    await showSkill(page);
    for (const label of ["승격", "편집", "삭제"])
      await expect(skillSheet(page).getByRole("button", { name: label, exact: true })).toBeDisabled();
    await skillSheet(page).getByRole("button", { name: "적합성 근거", exact: true }).click();
    await expect(skillSheet(page).getByRole("button", { name: "근거 기록", exact: true })).toBeDisabled();
    await expect(
      skillSheet(page).getByRole("button", { name: "적합성 근거 새로고침", exact: true }),
    ).toBeEnabled();
    await skillSheet(page).getByRole("button", { name: "정책 시뮬레이션", exact: true }).click();
    await skillSheet(page).getByRole("button", { name: "정책 확인", exact: true }).click();
    await expect(skillSheet(page).getByText("허용", { exact: true })).toBeVisible();
    expect(gateway.operations.filter((entry) => entry.kind === "compute").map(({ call }) => call)).toEqual([
      "POST /admin/skills/recommend",
      "POST /admin/skills/evaluate",
    ]);
    expect(gateway.mutations()).toEqual([]);
  });
  for (const id of ["observability.llm", "observability.xview"] as const) {
    test(`${id} ${mode}는 원문 권한이 있어도 외부 실행과 메모 변경을 막는다`, async ({ page, gateway }) => {
      gateway.setMode(id, mode);
      await login(page, id === "observability.llm" ? llmUrl : xviewUrl);
      await showInsight(page, id);
      for (const label of ["메모·태그 수정", "태그·메모 삭제"])
        await expect(noteCard(page).getByRole("button", { name: label, exact: true })).toBeDisabled();
      for (const label of ["분석 실행", "재실행"])
        await expect(page.getByRole("button", { name: label, exact: true })).toBeDisabled();
      await expect(noteCard(page)).toContainText("기존 공개 메모");
      const before = gateway.count(`GET /admin/requests/${requestId}/note`);
      await noteCard(page).getByRole("button", { name: "메모·태그 새로고침", exact: true }).click();
      await expect.poll(() => gateway.count(`GET /admin/requests/${requestId}/note`)).toBeGreaterThan(before);
      expect(gateway.mutations()).toEqual([]);
    });
  }
}

type Editor = "스킬 추가" | "적합성 근거" | "LLM 메모" | "XView 메모" | "피드백" | "저장 뷰" | "후보 채택";
const ownerFor = (editor: Editor): FeatureId =>
  editor === "스킬 추가" || editor === "적합성 근거" || editor === "후보 채택"
    ? "agents.skills"
    : editor === "XView 메모" || editor === "저장 뷰"
      ? "observability.xview"
      : "observability.llm";
const pathFor = (editor: Editor) =>
  ownerFor(editor) === "agents.skills"
    ? skillUrl
    : ownerFor(editor) === "observability.xview"
      ? xviewUrl
      : llmUrl;
async function prepareEditor(page: Page, editor: Editor) {
  if (editor === "스킬 추가") {
    await page.getByRole("button", { name: "스킬 추가", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "스킬 추가", exact: true });
    await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("fixture-created");
    const input = dialog.getByRole("textbox", { name: "설명", exact: true });
    await input.fill(draft);
    return {
      dialog,
      input,
      save: dialog.getByRole("button", { name: "스킬 만들기", exact: true }),
      call: "POST /admin/skills",
    };
  }
  if (editor === "적합성 근거") {
    await showFitness(page);
    const dialog = fitness(page),
      input = dialog.getByRole("textbox", { name: "참조 ID", exact: true });
    await input.fill(draft);
    return {
      dialog,
      input,
      save: dialog.getByRole("button", { name: "근거 기록 저장", exact: true }),
      call: "POST /admin/skills/fitness",
    };
  }
  if (editor === "LLM 메모" || editor === "XView 메모") {
    await showInsight(page, editor === "LLM 메모" ? "observability.llm" : "observability.xview");
    await noteCard(page).getByRole("button", { name: "메모·태그 수정", exact: true }).click();
    const dialog = note(page);
    await dialog.getByLabel("메모 변경 방법", { exact: true }).selectOption("replace");
    const input = dialog.getByLabel("새 메모", { exact: true });
    await input.fill(draft);
    return {
      dialog,
      input,
      save: dialog.getByRole("button", { name: "메모·태그 저장", exact: true }),
      call: `PATCH /admin/requests/${requestId}/note`,
    };
  }
  if (editor === "피드백") {
    await page.getByRole("tab", { name: /^피드백/u }).click();
    await page.getByRole("button", { name: "피드백 남기기", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "피드백 남기기", exact: true });
    await dialog.getByRole("textbox", { name: "요청 ID", exact: true }).fill(requestId);
    const input = dialog.getByRole("textbox", { name: "의견", exact: true });
    await input.fill(draft);
    return {
      dialog,
      input,
      save: dialog.getByRole("button", { name: "등록", exact: true }),
      call: "POST /admin/llm/feedback",
    };
  }
  if (editor === "저장 뷰") {
    await views(page).getByRole("button", { name: "새로 저장", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "현재 필터를 저장", exact: true });
    const input = dialog.getByRole("textbox", { name: "뷰 이름", exact: true });
    await input.fill(draft);
    return {
      dialog,
      input,
      save: dialog.getByRole("button", { name: "저장", exact: true }),
      call: "POST /admin/saved-filters",
    };
  }
  await page.getByRole("tab", { name: /^스튜디오/u }).click();
  await page.getByRole("button", { name: "공개 후보 채택하기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "후보를 스킬로 채택", exact: true }),
    input = dialog.getByRole("textbox", { name: "설명", exact: true });
  await input.fill(draft);
  return {
    dialog,
    input,
    save: dialog.getByRole("button", { name: "초안으로 채택", exact: true }),
    call: "POST /admin/skill-studio/adopt",
  };
}
for (const editor of [
  "스킬 추가",
  "적합성 근거",
  "LLM 메모",
  "XView 메모",
  "피드백",
  "저장 뷰",
  "후보 채택",
] as const) {
  test(`${editor} 열린 초안은 readonly 전환에 보존·잠금되고 복구 뒤 수동 저장만 허용한다`, async ({
    page,
    gateway,
  }) => {
    await login(page, pathFor(editor));
    const current = await prepareEditor(page, editor);
    await current.dialog.evaluate((element) => {
      (element as HTMLElement).dataset.draftIdentity = "same-live-dialog";
    });
    gateway.setMode(ownerFor(editor), "read_only");
    await refreshRuntime(page);
    await expect(current.dialog).toHaveAttribute("data-draft-identity", "same-live-dialog");
    await expect(current.input).toHaveValue(draft);
    await expect(current.input).toBeDisabled();
    await expect(current.save).toBeDisabled();
    await expect(current.dialog).toContainText(reason);
    await submitDirectly(current.dialog);
    expect(gateway.mutations()).toEqual([]);
    gateway.setMode(ownerFor(editor), "writable");
    await refreshRuntime(page);
    await expect(current.input).toBeEnabled();
    await expect(current.save).toBeEnabled();
    expect(gateway.mutations()).toEqual([]);
    await current.save.click();
    await expect(current.dialog).toBeHidden();
    expect(gateway.mutations().map(({ call }) => call)).toEqual([current.call]);
  });
}

for (const editor of ["적합성 근거", "LLM 메모", "피드백"] as const) {
  test(`${editor} 저장 오류 뒤 readonly 전환은 재시도도 막고 복구 뒤 수동 재시도만 허용한다`, async ({
    page,
    gateway,
  }) => {
    await login(page, pathFor(editor));
    const current = await prepareEditor(page, editor);
    gateway.failWrites();
    await current.save.click();
    await expect(current.dialog.getByRole("alert")).toContainText("req-readonly-fixture");
    expect(gateway.count(current.call)).toBe(1);
    await expect(current.input).toHaveValue(draft);
    gateway.setMode(ownerFor(editor), "preview_read_only");
    await refreshRuntime(page);
    await expect(current.save).toBeDisabled();
    await expect(current.input).toHaveValue(draft);
    await submitDirectly(current.dialog);
    expect(gateway.count(current.call)).toBe(1);
    gateway.succeedWrites();
    gateway.setMode(ownerFor(editor), "writable");
    await refreshRuntime(page);
    await expect(current.save).toBeEnabled();
    expect(gateway.count(current.call)).toBe(1);
    await current.save.click();
    await expect(current.dialog).toBeHidden();
    expect(gateway.count(current.call)).toBe(2);
  });
}

test("읽기 전용의 저장 뷰는 조회·적용·링크 복사가 가능하고 생성·덮어쓰기·삭제는 금지된다", async ({
  page,
  context,
  gateway,
}) => {
  gateway.setMode("observability.xview", "preview_read_only");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, xviewUrl);
  await views(page).getByRole("combobox", { name: "저장된 뷰", exact: true }).selectOption(viewId);
  await expect(page).toHaveURL(/models=fixture-model/u);
  for (const label of ["새로 저장", "덮어쓰기", "삭제"])
    await expect(views(page).getByRole("button", { name: label, exact: true })).toBeDisabled();
  await views(page).getByRole("button", { name: "링크 복사", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  expect(gateway.mutations()).toEqual([]);
});
test("읽기 전용 피드백은 조회를 유지하고 새 등록을 막는다", async ({ page, gateway }) => {
  gateway.setMode("observability.llm", "preview_read_only");
  await login(page, llmUrl);
  await page.getByRole("tab", { name: /^피드백/u }).click();
  await expect(page.getByRole("button", { name: "피드백 남기기", exact: true })).toBeDisabled();
  await expect(page.getByText("등록된 피드백이 없습니다.", { exact: true })).toBeVisible();
  expect(gateway.count("GET /admin/llm/feedback")).toBeGreaterThan(0);
  expect(gateway.mutations()).toEqual([]);
});

for (const action of ["시드", "추천 적용", "스킬 삭제", "승격", "재실행", "뷰 삭제", "메모 삭제"] as const) {
  test(`${action} 확인창도 열린 뒤 readonly 전환 시 실행을 막고 취소할 수 있다`, async ({
    page,
    gateway,
  }) => {
    const owner: FeatureId =
      action === "재실행" || action === "메모 삭제"
        ? "observability.llm"
        : action === "뷰 삭제"
          ? "observability.xview"
          : "agents.skills";
    await login(
      page,
      owner === "agents.skills" ? skillUrl : owner === "observability.llm" ? llmUrl : xviewUrl,
    );
    let dialog: Locator, confirm: Locator;
    if (action === "시드") {
      await page.getByRole("button", { name: "추천 스킬 추가", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "추천 스킬 추가", exact: true });
      confirm = dialog.getByRole("button", { name: "시드 실행", exact: true });
    } else if (action === "추천 적용") {
      await page.getByRole("button", { name: "스킬 추천", exact: true }).click();
      await page.getByRole("button", { name: "초안으로 적용", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "추천을 초안으로 적용", exact: true });
      confirm = dialog.getByRole("button", { name: "초안 생성", exact: true });
    } else if (action === "스킬 삭제" || action === "승격") {
      await showSkill(page);
      await skillSheet(page)
        .getByRole("button", { name: action === "승격" ? "승격" : "삭제", exact: true })
        .click();
      dialog = page.getByRole("dialog", { name: action === "승격" ? "스킬 승격" : "스킬 삭제", exact: true });
      confirm = dialog.getByRole("button", { name: action === "승격" ? "승격" : "삭제", exact: true });
      if (action === "승격")
        await dialog.getByRole("textbox", { name: "변경 사유", exact: true }).fill("공개 합성 검증 사유");
    } else if (action === "뷰 삭제") {
      await views(page).getByRole("combobox", { name: "저장된 뷰", exact: true }).selectOption(viewId);
      await views(page).getByRole("button", { name: "삭제", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "저장된 뷰 삭제", exact: true });
      confirm = dialog.getByRole("button", { name: "삭제", exact: true });
    } else {
      await showInsight(page, "observability.llm");
      await page
        .getByRole("button", { name: action === "재실행" ? "재실행" : "태그·메모 삭제", exact: true })
        .click();
      dialog = page.getByRole("dialog", {
        name: action === "재실행" ? "이 요청을 다시 실행할까요?" : "요청 태그·메모 삭제",
        exact: true,
      });
      confirm = dialog.getByRole("button", {
        name: action === "재실행" ? "재실행" : "태그·메모 삭제",
        exact: true,
      });
    }
    await expect(dialog).toBeVisible();
    await expect(confirm).toBeEnabled();
    gateway.setMode(owner, "preview_read_only");
    await refreshRuntime(page);
    await expect(confirm).toBeDisabled();
    await expect(dialog).toContainText(reason);
    expect(gateway.mutations()).toEqual([]);
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(gateway.mutations()).toEqual([]);
  });
}

async function selectHeldFile(page: Page) {
  await page.evaluate(() => {
    const original = File.prototype.text;
    const scope = window as unknown as { fileReadStarted: boolean; resumeFileRead?: () => void };
    scope.fileReadStarted = false;
    File.prototype.text = async function () {
      scope.fileReadStarted = true;
      await new Promise<void>((resolve) => {
        scope.resumeFileRead = resolve;
      });
      File.prototype.text = original;
      return original.call(this);
    };
  });
  const file = "tests/fixtures/readonly-skills.json";
  await page.getByLabel("가져오기", { exact: true }).setInputFiles(file);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { fileReadStarted: boolean }).fileReadStarted))
    .toBe(true);
  return file;
}

test("파일 읽기 뒤 실제 import API 직전 readonly 재검사로 오래된 가져오기를 막는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const file = await selectHeldFile(page);
  gateway.setMode("agents.skills", "read_only");
  await refreshRuntime(page);
  await expect(page.getByLabel("가져오기", { exact: true })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { resumeFileRead?: () => void }).resumeFileRead?.());
  await expect(page.locator("[data-sonner-toast]")).toContainText("이 작업을 수행할 권한이 없습니다.");
  expect(gateway.mutations()).toEqual([]);
  gateway.setMode("agents.skills", "writable");
  await refreshRuntime(page);
  await expect(page.getByLabel("가져오기", { exact: true })).toBeEnabled();
  expect(gateway.mutations()).toEqual([]);
  await page.getByLabel("가져오기", { exact: true }).setInputFiles(file);
  await expect.poll(() => gateway.count("POST /admin/skills/import")).toBe(1);
});

test("이전 세션에서 읽던 파일은 새 쓰기 가능 계정으로 가져오거나 알림을 남기지 않는다", async ({
  page,
  context,
  gateway,
}) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  const file = await selectHeldFile(page);
  await other.getByLabel("사용자 메뉴").click();
  await other.getByRole("button", { name: "로그아웃", exact: true }).click();
  await signIn(page, secondEmail);
  await expect(page.getByLabel("가져오기", { exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { resumeFileRead?: () => void }).resumeFileRead?.());
  await page.waitForTimeout(500);
  expect(gateway.mutations()).toEqual([]);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.getByLabel("가져오기", { exact: true }).setInputFiles(file);
  await expect.poll(() => gateway.count("POST /admin/skills/import")).toBe(1);
  expect(gateway.mutations()[0]?.userId).toBe("readonly-two");
});

test("readonly 해제는 기존 admin:write와 원문 보기 권한을 새로 부여하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page, llmUrl);
  await showInsight(page, "observability.llm");
  gateway.setMode("observability.llm", "read_only");
  gateway.setWritable(false);
  gateway.setRaw(false);
  await refreshRuntime(page);
  // Raw capability changes retire the read owner, unlike write-only restrictions.
  await expect(page.getByRole("dialog", { name: "LLM 호출 상세", exact: true })).toHaveCount(0);
  await expect(noteCard(page)).toHaveCount(0);
  gateway.setMode("observability.llm", "writable");
  await refreshRuntime(page);
  await expect(page.getByRole("dialog", { name: "LLM 호출 상세", exact: true })).toHaveCount(0);
  await showInsight(page, "observability.llm");
  await expect(noteCard(page).getByRole("button", { name: "메모·태그 수정", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "분석 실행", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "재실행", exact: true })).toBeDisabled();
  expect(gateway.mutations()).toEqual([]);
});

test("읽기 전용 복구는 외부 분석과 저장 뷰 덮어쓰기를 자동 실행하지 않는다", async ({ page, gateway }) => {
  await login(page, xviewUrl);
  await views(page).getByRole("combobox", { name: "저장된 뷰", exact: true }).selectOption(viewId);
  gateway.setMode("observability.xview", "read_only");
  await refreshRuntime(page);
  await expect(views(page).getByRole("button", { name: "덮어쓰기", exact: true })).toBeDisabled();
  gateway.setMode("observability.xview", "writable");
  await refreshRuntime(page);
  await expect(views(page).getByRole("button", { name: "덮어쓰기", exact: true })).toBeEnabled();
  expect(gateway.mutations()).toEqual([]);
  await views(page).getByRole("button", { name: "덮어쓰기", exact: true }).click();
  await expect.poll(() => gateway.count(`PATCH /admin/saved-filters/${viewId}`)).toBe(1);
  await showInsight(page, "observability.xview");
  gateway.setMode("observability.xview", "read_only");
  await refreshRuntime(page);
  await expect(page.getByRole("button", { name: "분석 실행", exact: true })).toBeDisabled();
  gateway.setMode("observability.xview", "writable");
  await refreshRuntime(page);
  await expect(page.getByRole("button", { name: "분석 실행", exact: true })).toBeEnabled();
  expect(gateway.count(`POST /admin/requests/${requestId}/analyze`)).toBe(0);
  await page.getByRole("button", { name: "분석 실행", exact: true }).click();
  await page.getByText("분석 결과 펼치기", { exact: true }).click();
  await expect(page.getByText("합성 분석 결과", { exact: true })).toBeVisible();
  expect(gateway.mutations().map(({ call }) => call)).toEqual([
    `PATCH /admin/saved-filters/${viewId}`,
    `POST /admin/requests/${requestId}/analyze`,
  ]);
});

for (const editor of ["적합성 근거", "LLM 메모"] as const) {
  test(`${editor} 이미 전송한 저장은 완료되더라도 readonly 버튼과 신규 전송을 되살리지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page, pathFor(editor));
    const current = await prepareEditor(page, editor);
    gateway.holdWrites();
    await current.save.click();
    await expect.poll(() => gateway.mutations().length).toBe(1);
    gateway.setMode(ownerFor(editor), "read_only");
    await refreshRuntime(page);
    await expect(current.input).toHaveValue(draft);
    await expect(current.input).toBeDisabled();
    gateway.releaseWrites();
    await expect(current.dialog).toBeHidden();
    const trigger =
      editor === "적합성 근거"
        ? skillSheet(page).getByRole("button", { name: "근거 기록", exact: true })
        : noteCard(page).getByRole("button", { name: "메모·태그 수정", exact: true });
    await expect(trigger).toBeDisabled();
    expect(gateway.mutations().map(({ call }) => call)).toEqual([current.call]);
  });
}

test("이전 세션의 늦은 저장 응답은 새 계정의 readonly 화면과 알림을 변경하지 않는다", async ({
  page,
  context,
  gateway,
}) => {
  await login(page);
  const other = await context.newPage();
  await login(other);
  const current = await prepareEditor(page, "적합성 근거");
  gateway.holdWrites();
  await current.save.click();
  await expect.poll(() => gateway.mutations().length).toBe(1);
  await other.getByLabel("사용자 메뉴").click();
  await other.getByRole("button", { name: "로그아웃", exact: true }).click();
  gateway.setMode("agents.skills", "preview_read_only");
  await signIn(page, secondEmail);
  await expect(
    page.getByRole("button", { name: "스킬 추가", exact: true, includeHidden: true }),
  ).toBeDisabled();
  const response = page.waitForResponse(
    (value) =>
      new URL(value.url()).pathname === "/admin/skills/fitness" && value.request().method() === "POST",
  );
  gateway.releaseWrites();
  await (await response).finished();
  await page.waitForTimeout(500);
  await expect(fitness(page)).toBeHidden();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  expect(gateway.mutations()).toHaveLength(1);
});

test("390px 다크 readonly 초안은 한글 안내·취소/폐기·포커스·axe·엄격한 넘침을 유지한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  const current = await prepareEditor(page, "적합성 근거");
  gateway.setMode("agents.skills", "read_only");
  await refreshRuntime(page);
  await expect(current.dialog).toContainText(reason);
  await expect(current.input).toHaveValue(draft);
  await noOverflow(page, current.dialog);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("feature-readonly-mobile-dark.png") });
  await page.keyboard.press("Escape");
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(current.input).toHaveValue(draft);
  await expect(current.input).toBeDisabled();
  await page.keyboard.press("Escape");
  await noOverflow(page, guard(page));
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("feature-readonly-discard-mobile-dark.png") });
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(current.dialog).toBeHidden();
  await expect
    .poll(() =>
      skillSheet(page).evaluate(
        (element) =>
          document.activeElement instanceof HTMLElement &&
          element.contains(document.activeElement) &&
          document.activeElement.isConnected &&
          document.activeElement.getClientRects().length > 0 &&
          !document.activeElement.matches(":disabled"),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Tab");
  expect(await skillSheet(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  expect(gateway.mutations()).toEqual([]);
});

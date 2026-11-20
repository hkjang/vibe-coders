import { Buffer } from "node:buffer";
import { expect, test, type Page } from "@playwright/test";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";
import { refreshRuntime } from "../fixtures/agent-code-editor";
import { probeCsvReviewFixture } from "../../src/test/probe-csv-review";

const csv = '\ufeffcase_key,input_template\r\npublic-key,"공개 합성 프롬프트 😀\r\n둘째 줄"\r\n';
const upload = (body = csv, name = "prompts.csv", mimeType = "text/csv") => ({
  name,
  mimeType,
  buffer: Buffer.from(body),
});
async function install(page: Page) {
  const base = await installPromptLibrary(page);
  base.bootstrap.backend_version = "v0.86.163";
  base.bootstrap.allowed_features = ["security.redteam"];
  base.bootstrap.user?.scopes?.push("security:read");
  const feature = base.bootstrap.migration_registry[0];
  if (!feature) throw new Error("missing synthetic feature");
  Object.assign(feature, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  const writes: Array<{ bytes: number[]; headers: Record<string, string> }> = [];
  const reviews: Array<{ bytes: number[]; headers: Record<string, string> }> = [];
  const exports: string[] = [];
  let reads = 0,
    responseStatus = 200,
    reviewStatus = 200;
  const review = probeCsvReviewFixture();
  let held: "apply" | "review" | "export" | undefined;
  let hold: Promise<void> | undefined;
  let release = () => {};
  let finished = Promise.resolve();
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const kind = path.endsWith("/import-review")
      ? "review"
      : path.endsWith("/import")
        ? "apply"
        : path.endsWith("/export")
          ? "export"
          : undefined;
    if (kind) {
      if (kind === "export") {
        expect(request.method()).toBe("GET");
        exports.push(request.url());
      } else {
        expect(request.method()).toBe(kind === "review" ? "POST" : "PUT");
        (kind === "review" ? reviews : writes).push({
          bytes: Array.from(request.postDataBuffer() ?? []),
          headers: request.headers(),
        });
      }
      let finish = () => {};
      if (held === kind)
        finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
      try {
        if (held === kind) await hold;
        if (kind === "export")
          return await route.fulfill({ contentType: "text/csv; charset=utf-8", body: csv });
        const status = kind === "review" ? reviewStatus : responseStatus;
        const offset = Number(url.searchParams.get("offset") ?? 0),
          limit = Number(url.searchParams.get("limit") ?? 20);
        const payload =
          kind === "review"
            ? {
                ...review,
                offset,
                limit,
                has_more: offset + limit < review.total_items,
                changes: review.changes.slice(offset, offset + limit),
              }
            : {
                review_applied: true,
                applied_revision: review.revision,
                imported_cases: review.imported_cases,
                packs_touched: 1,
                skipped: null,
              };
        return await route.fulfill({
          status,
          headers: { "x-request-id": "public-csv-request" },
          json:
            status === 200
              ? payload
              : {
                  error: {
                    message: "private raw CSV must not appear",
                    code: status === 409 ? "redteam_import_review_changed" : "synthetic_failure",
                  },
                },
        });
      } finally {
        finish();
      }
    }
    expect(request.method()).toBe("GET");
    if (path.endsWith("/probe-packs")) {
      reads++;
      return route.fulfill({ json: { probe_packs: [], count: 0 } });
    }
    if (path.endsWith("/targets")) return route.fulfill({ json: { targets: [], count: 0 } });
    if (path.endsWith("/kill-switch")) return route.fulfill({ json: { enabled: false } });
    return route.fulfill({ json: {} });
  });
  return {
    ...base,
    feature,
    writes,
    reviews,
    exports,
    reads: () => reads,
    setStatus: (value: number) => {
      responseStatus = value;
    },
    setReviewStatus: (value: number) => {
      reviewStatus = value;
    },
    longValue: (text: string) => {
      const source = review.changes[1];
      if (!source || source.kind !== "case") throw new Error("missing case");
      source.after.input_template = text;
    },
    many: () => {
      const source = review.changes[1];
      if (!source || source.kind !== "case") throw new Error("missing case");
      review.changes = [
        review.changes[0],
        ...Array.from({ length: 21 }, (_, i) => ({
          ...source,
          id: "case-" + i,
          after: { ...source.after, id: "case-" + i, case_key: "case-" + i },
          before: source.before ? { ...source.before, id: "case-" + i } : null,
        })),
      ].filter((value): value is NonNullable<typeof value> => value !== undefined);
      review.total_items = 22;
      review.imported_cases = 21;
      review.counts = { created: 0, updated: 21, unchanged: 1 };
    },
    hold: (kind: "apply" | "review" | "export" = "apply") => {
      held = kind;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: async () => {
      release();
      await finished;
      hold = undefined;
      held = undefined;
    },
  };
}
async function open(page: Page) {
  await page.goto("redteam?tab=targets");
  await expect(page.getByRole("button", { name: "CSV 가져오기", exact: true })).toBeEnabled();
}
async function confirm(page: Page) {
  const dialog = page.getByRole("dialog", { name: "CSV 변경 내용 확인" });
  await expect(dialog.getByRole("heading", { name: "적용 예정 내용" })).toBeVisible();
  await dialog.getByRole("checkbox", { name: /원본 파일을 적용/ }).check();
  await dialog.getByRole("button", { name: "변경 내용 적용", exact: true }).click();
}
async function discard(page: Page) {
  await page
    .getByRole("dialog", { name: "CSV 변경 내용 확인" })
    .getByRole("button", { name: "취소", exact: true })
    .click();
  await page.getByRole("alertdialog").getByRole("button", { name: "변경 버리기", exact: true }).click();
}

test("review precedes an explicitly confirmed PUT and preserves original BOM/CRLF download bytes", async ({
  page,
}) => {
  const parserLoads: string[] = [];
  const dialogLoads: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/ProbeCsvImportDialog-[^/]+\.js$/u.test(new URL(request.url()).pathname))
      dialogLoads.push(request.url());
    if (/\/assets\/probe-csv-file-[^/]+\.js$/u.test(new URL(request.url()).pathname))
      parserLoads.push(request.url());
  });
  const api = await install(page);
  await open(page);
  const initialReads = api.reads();
  expect(parserLoads).toEqual([]);
  expect(dialogLoads).toEqual([]);
  await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
  const dialog = page.getByRole("dialog", { name: "CSV 변경 내용 확인" });
  await expect(dialog.getByRole("heading", { name: "적용 예정 내용" })).toBeVisible();
  await expect(dialog).toContainText("기존 공개 프롬프트");
  await expect(dialog).toContainText("검토한 공개 프롬프트");
  await expect(dialog.getByRole("button", { name: "변경 내용 적용", exact: true })).toBeDisabled();
  expect(api.writes).toHaveLength(0);
  expect(api.reads()).toBe(initialReads);
  expect(api.reviews[0]?.bytes).toEqual(Array.from(new TextEncoder().encode(csv)));
  await confirm(page);
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText("프롬프트 1건");
  expect(api.writes).toHaveLength(1);
  expect(parserLoads).toHaveLength(1);
  expect(dialogLoads).toHaveLength(1);
  expect(api.writes[0]?.bytes).toEqual(Array.from(new TextEncoder().encode(csv)));
  expect(api.writes[0]?.headers).toMatchObject({
    "content-type": "text/csv",
    "x-vibe-ui": "app",
    "if-match": '"' + "a".repeat(64) + '"',
  });
  expect(api.reads()).toBeGreaterThan(initialReads);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기(엑셀)", exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("redteam-probe-prompts.csv");
  const stream = await file.createReadStream();
  if (!stream) throw new Error("missing download");
  const bytes: number[] = [];
  for await (const chunk of stream) bytes.push(...new Uint8Array(chunk));
  expect(bytes).toEqual(Array.from(new TextEncoder().encode(csv)));
  api.check();
});

for (const [label, file] of [
  ["wrong extension", upload(csv, "prompts.txt")],
  ["wrong MIME", upload(csv, "prompts.csv", "text/html")],
  ["invalid final row", upload(csv + 'last,"unterminated')],
] as const) {
  test(label + " fails before review or write and permits a fresh selection", async ({ page }) => {
    const api = await install(page);
    await open(page);
    await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(file);
    await expect(page.getByRole("alert")).toBeVisible();
    expect(api.writes).toEqual([]);
    expect(api.reviews).toEqual([]);
    await discard(page);
    await expect(page.getByRole("button", { name: "CSV 가져오기", exact: true })).toBeFocused();
    await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
    await confirm(page);
    await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText("프롬프트 1건");
    expect(api.writes).toHaveLength(1);
    api.check();
  });
}

for (const phase of ["review", "apply"] as const) {
  test(
    "read-only transition aborts held " + phase + " without stale feedback or replay",
    async ({ page }) => {
      const api = await install(page);
      await open(page);
      api.hold(phase);
      const requested = page.waitForRequest((request) =>
        new URL(request.url()).pathname.endsWith(
          phase === "review" ? "/probe-packs/import-review" : "/probe-packs/import",
        ),
      );
      await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
      if (phase === "apply") await confirm(page);
      const request = await requested;
      api.feature.read_only = true;
      await refreshRuntime(page);
      await expect.poll(() => request.failure()?.errorText).toBe("net::ERR_ABORTED");
      const settledReads = api.reads();
      await api.release();
      expect(api.reads()).toBe(settledReads);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: "CSV 변경 내용 확인" })).toHaveCount(0);
      api.feature.read_only = false;
      await refreshRuntime(page);
      await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
      await confirm(page);
      await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText("프롬프트 1건");
      expect(api.writes).toHaveLength(phase === "review" ? 1 : 2);
      api.check();
    },
  );
}

test("a changed filter retires a held export without saving a stale file", async ({ page }) => {
  const api = await install(page);
  await open(page);
  const downloads: string[] = [];
  page.on("download", (file) => downloads.push(file.suggestedFilename()));
  api.hold("export");
  const requested = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/probe-packs/export"),
  );
  await page.getByRole("button", { name: "CSV 내보내기(엑셀)", exact: true }).click();
  const request = await requested;
  await page.getByPlaceholder("이름, 유형, 위험도, 제공자, 담당 팀", { exact: true }).fill("next");
  await page.getByPlaceholder("이름, 유형, 위험도, 제공자, 담당 팀", { exact: true }).press("Enter");
  await expect.poll(() => request.failure()?.errorText).toBe("net::ERR_ABORTED");
  await api.release();
  expect(downloads).toEqual([]);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  api.check();
});

test("an uncertain apply retires confirmation and requires a fresh explicit review", async ({ page }) => {
  const api = await install(page);
  api.setStatus(503);
  await open(page);
  const initialReads = api.reads();
  await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
  await confirm(page);
  await expect(page.getByRole("alert")).toContainText("public-csv-request");
  await expect(page.getByRole("alert")).not.toContainText("private raw CSV");
  expect(api.writes).toHaveLength(1);
  expect(api.reads()).toBe(initialReads);
  await expect(page.getByRole("button", { name: "변경 내용 적용", exact: true })).toBeDisabled();
  api.setStatus(200);
  await page.getByRole("button", { name: "현재 내용으로 다시 검토" }).click();
  await expect(page.getByRole("checkbox", { name: /원본 파일을 적용/ })).not.toBeChecked();
  expect(api.writes).toHaveLength(1);
  await confirm(page);
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText("프롬프트 1건");
  expect(api.writes).toHaveLength(2);
  api.check();
});

test("paging binds the exact file and resets confirmation; stale pages disable apply", async ({ page }) => {
  const api = await install(page);
  api.many();
  await open(page);
  await page
    .getByLabel("프롬프트 CSV 파일 선택", { exact: true })
    .setInputFiles(
      upload(
        "case_key,input_template\n" +
          Array.from({ length: 21 }, (_, i) => "case-" + i + ",public\n").join(""),
      ),
    );
  await expect(page.getByRole("heading", { name: "적용 예정 내용" })).toBeVisible();
  await page.getByRole("checkbox", { name: /원본 파일을 적용/ }).check();
  await page.getByRole("button", { name: "다음 변경", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /원본 파일을 적용/ })).not.toBeChecked();
  expect(api.reviews).toHaveLength(2);
  expect(api.reviews[1]?.bytes).toEqual(api.reviews[0]?.bytes);
  expect(api.reviews[1]?.headers["if-match"]).toBe('"' + "a".repeat(64) + '"');
  api.setReviewStatus(409);
  await page.getByRole("button", { name: "이전 변경", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("다시 검토");
  await expect(page.getByRole("button", { name: "변경 내용 적용", exact: true })).toBeDisabled();
  expect(api.writes).toHaveLength(0);
  api.check();
});

test("Escape keeps review until discard is explicitly confirmed and restores trigger focus", async ({
  page,
}) => {
  const api = await install(page);
  await open(page);
  await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
  await expect(page.getByRole("heading", { name: "적용 예정 내용" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "계속 편집", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "계속 편집", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "CSV 변경 내용 확인" })).toBeVisible();
  await discard(page);
  await expect(page.getByRole("button", { name: "CSV 가져오기", exact: true })).toBeFocused();
  expect(api.writes).toHaveLength(0);
  api.check();
});

test("large values stay outside the initial DOM and expand without changing the imported file", async ({
  page,
}) => {
  const api = await install(page);
  const text = "공개 😀".repeat(2000) + "최종 꼬리";
  const body = "case_key,input_template\npublic-key," + text + "\n";
  api.longValue(text);
  await open(page);
  await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload(body));
  const dialog = page.getByRole("dialog", { name: "CSV 변경 내용 확인" });
  const value = dialog.getByLabel("요청 프롬프트 적용 후 값", { exact: true });
  await expect(value).toBeVisible();
  expect((await value.textContent())?.length).toBeLessThanOrEqual(2048);
  await expect(dialog).not.toContainText("최종 꼬리");
  const expand = dialog.getByRole("button", { name: "요청 프롬프트 적용 후 값 전체 펼치기", exact: true });
  await expand.focus();
  await page.keyboard.press("Enter");
  expect(await value.textContent()).toBe(JSON.stringify(text));
  await expect(dialog.getByRole("checkbox", { name: /원본 파일을 적용/ })).not.toBeChecked();
  expect(api.writes).toHaveLength(0);
  await dialog.getByRole("button", { name: "요청 프롬프트 적용 후 값 접기", exact: true }).click();
  expect((await value.textContent())?.length).toBeLessThanOrEqual(2048);
  await confirm(page);
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText("프롬프트 1건");
  expect(api.writes[0]?.bytes).toEqual(Array.from(Buffer.from(body)));
  api.check();
});

for (const [reason, text] of [
  ["credential", "vc_sk_" + "x".repeat(43) + "가".repeat(4096)],
  ["inspection limit", "가".repeat(16385)],
] as const) {
  test(reason + " remains masked without an expansion action", async ({ page }) => {
    const api = await install(page);
    api.longValue(text);
    await open(page);
    await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
    const dialog = page.getByRole("dialog", { name: "CSV 변경 내용 확인" });
    await expect(dialog.getByLabel("요청 프롬프트 적용 후 값", { exact: true })).toContainText("민감정보");
    await expect(dialog).not.toContainText(text);
    await expect(
      dialog.getByRole("button", { name: "요청 프롬프트 적용 후 값 전체 펼치기", exact: true }),
    ).toHaveCount(0);
    expect(api.writes).toHaveLength(0);
    api.check();
  });
}

for (const width of [390, 1440]) {
  test("comparison dialog is bounded and usable at " + width + "px", async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await install(page);
    await open(page);
    await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
    const dialog = page.getByRole("dialog", { name: "CSV 변경 내용 확인" });
    await expect(dialog.getByRole("heading", { name: "적용 예정 내용" })).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.x ?? -1) >= 0).toBe(true);
    expect((bounds?.width ?? 9999) <= width).toBe(true);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await dialog.screenshot({
      path: testInfo.outputPath("probe-csv-review-" + width + ".png"),
      animations: "disabled",
    });
    await confirm(page);
    await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText("프롬프트 1건");
    api.check();
  });
}

import { Buffer } from "node:buffer";
import { expect, test, type Page } from "@playwright/test";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";
import { refreshRuntime } from "../fixtures/agent-code-editor";

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
  const exports: string[] = [];
  let reads = 0;
  let responseStatus = 200;
  let hold: Promise<void> | undefined;
  let release = () => {};
  let finished = Promise.resolve();
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/probe-packs/import") || path.endsWith("/probe-packs/export")) {
      const importing = path.endsWith("/import");
      if (importing) {
        expect(request.method()).toBe("POST");
        writes.push({ bytes: Array.from(request.postDataBuffer() ?? []), headers: request.headers() });
      } else {
        expect(request.method()).toBe("GET");
        exports.push(request.url());
      }
      let finish = () => {};
      finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        await hold;
        if (!importing) return await route.fulfill({ contentType: "text/csv; charset=utf-8", body: csv });
        return await route.fulfill({
          status: responseStatus,
          headers: { "x-request-id": "public-csv-request" },
          json:
            responseStatus === 200
              ? { imported_cases: 1, packs_touched: 1, skipped: null }
              : { error: { message: "private raw CSV must not appear" } },
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
    exports,
    reads: () => reads,
    setStatus: (value: number) => {
      responseStatus = value;
    },
    hold: () => {
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: async () => {
      release();
      await finished;
      hold = undefined;
    },
  };
}
async function open(page: Page) {
  await page.goto("redteam?tab=targets");
  await expect(page.getByRole("button", { name: "CSV 가져오기", exact: true })).toBeEnabled();
}

test("imports once through the registered raw transport and downloads identical BOM/CRLF bytes", async ({
  page,
}) => {
  const parserLoads: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/probe-csv-file-[^/]+\.js$/u.test(new URL(request.url()).pathname))
      parserLoads.push(request.url());
  });
  const api = await install(page);
  await open(page);
  const initialReads = api.reads();
  expect(parserLoads).toEqual([]);
  await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText("프롬프트 1건");
  expect(api.writes).toHaveLength(1);
  expect(parserLoads).toHaveLength(1);
  expect(api.writes[0]?.bytes).toEqual(Array.from(new TextEncoder().encode(csv)));
  expect(api.writes[0]?.headers).toMatchObject({ "content-type": "text/csv", "x-vibe-ui": "app" });
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
  expect(api.exports).toHaveLength(1);
  api.check();
});

for (const [label, file] of [
  ["wrong extension", upload(csv, "prompts.txt")],
  ["wrong MIME", upload(csv, "prompts.csv", "text/html")],
  ["invalid final row", upload(csv + 'last,"unterminated')],
] as const) {
  test(`${label} fails before any server write and permits a fresh selection`, async ({ page }) => {
    const api = await install(page);
    await open(page);
    await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(file);
    await expect(page.getByRole("alert")).toBeVisible();
    expect(api.writes).toEqual([]);
    await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
    await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText("프롬프트 1건");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(api.writes).toHaveLength(1);
    api.check();
  });
}

for (const boundary of ["readOnly", "filter", "tab"] as const) {
  test(`held CSV upload is aborted on ${boundary}, with no stale feedback or automatic replay`, async ({
    page,
  }) => {
    const api = await install(page);
    await open(page);
    api.hold();
    const requested = page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith("/probe-packs/import"),
    );
    await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
    const request = await requested;
    await expect(page.getByRole("button", { name: "CSV 가져오기", exact: true })).toBeDisabled();
    if (boundary === "readOnly") {
      api.feature.read_only = true;
      await refreshRuntime(page);
    }
    if (boundary === "filter") {
      const search = page.getByPlaceholder("이름, 유형, 위험도, 제공자, 담당 팀", { exact: true });
      await search.fill("next");
      await search.press("Enter");
    }
    if (boundary === "tab") await page.getByRole("tab", { name: "캠페인", exact: true }).click();
    await expect.poll(() => request.failure()?.errorText).toBe("net::ERR_ABORTED");
    const settledReads = api.reads();
    await api.release();
    expect(api.reads()).toBe(settledReads);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    if (boundary === "readOnly") {
      api.feature.read_only = false;
      await refreshRuntime(page);
    }
    if (boundary === "tab") await page.getByRole("tab", { name: "대상·검사 묶음", exact: true }).click();
    await expect(page.getByRole("button", { name: "CSV 가져오기", exact: true })).toBeEnabled();
    expect(api.writes).toHaveLength(1);
    await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
    await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText("프롬프트 1건");
    expect(api.writes).toHaveLength(2);
    api.check();
  });
}

test("a changed filter retires a held export without saving a stale file", async ({ page }) => {
  const api = await install(page);
  await open(page);
  const downloads: string[] = [];
  page.on("download", (file) => downloads.push(file.suggestedFilename()));
  api.hold();
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
  const next = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기(엑셀)", exact: true }).click();
  await next;
  expect(downloads).toHaveLength(1);
  expect(api.exports).toHaveLength(2);
  api.check();
});

test("an uncertain write shows a safe request id and sends no automatic retry", async ({ page }) => {
  const api = await install(page);
  api.setStatus(503);
  await open(page);
  const initialReads = api.reads();
  await page.getByLabel("프롬프트 CSV 파일 선택", { exact: true }).setInputFiles(upload());
  await expect(page.getByRole("alert")).toContainText("public-csv-request");
  await expect(page.getByRole("alert")).not.toContainText("private raw CSV");
  expect(api.writes).toHaveLength(1);
  expect(api.reads()).toBe(initialReads);
  await expect(page.getByRole("button", { name: "CSV 가져오기", exact: true })).toBeEnabled();
  api.check();
});

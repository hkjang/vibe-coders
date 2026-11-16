import { expect, type Download, type Page } from "@playwright/test";
import { test, recorder, sessionA, type FlightRecorderGateway } from "./fixtures/flight-recorder-state";

async function readCsv(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Uint8Array[] = [];
  for await (const value of stream) {
    const chunk: unknown = value;
    if (!(chunk instanceof Uint8Array)) throw new Error("Expected native download bytes");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

function records() {
  const body = recorder();
  const event = body.events[0];
  if (!event) throw new Error("Missing synthetic event");
  return {
    ...body,
    rollup: { ...body.rollup, requests: 3 },
    events: [
      { ...event, request_id: "public-normal-row", tool_count: 0 },
      {
        ...event,
        request_id: "public-error-row",
        is_error: true,
        tool_count: 0,
        created_at: "2026-10-01T00:00:01Z",
      },
      {
        ...event,
        request_id: "public-risk-row",
        kind: "messages",
        secret_events: 2,
        created_at: "2026-10-01T00:00:02Z",
      },
    ],
  };
}
async function enter(page: Page, gateway: FlightRecorderGateway) {
  gateway.authMode("open");
  gateway.target(sessionA.session_id, { body: records() });
  await page.goto(`observability/sessions?session_id=${sessionA.session_id}`);
  await expect(page.getByRole("status", { name: "세션 기록 표시 범위" })).toContainText(
    "수신 3건 중 3건 표시",
  );
}

test("유형·조건의 교집합, 표시 순서와 실제 CSV 범위가 일치한다", async ({ page, gateway }) => {
  await enter(page, gateway);
  const dialog = page.getByRole("dialog");
  const list = dialog.getByRole("list", { name: "표시 중인 세션 기록" });
  await dialog.getByLabel("표시 순서").selectOption("newest");
  await expect(list.getByRole("listitem").first()).toContainText("public-risk-row");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "CSV 내보내기", exact: true }).click();
  const text = await readCsv(await download);
  expect(text.indexOf("public-risk-row")).toBeLessThan(text.indexOf("public-normal-row"));
  await dialog.getByLabel("기록 조건").selectOption("risk");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  const filtered = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "CSV 내보내기", exact: true }).click();
  const csv = await readCsv(await filtered);
  expect(csv).toContain("public-risk-row");
  expect(csv).not.toMatch(/public-normal-row|public-error-row|public-preview-not-a-csv-column/);
  await dialog.getByLabel("요청 유형").selectOption("chat");
  await expect(dialog.getByText("조건에 맞는 수신 기록이 없습니다.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "CSV 내보내기", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "모든 수신 기록 보기" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(3);
  expect(gateway.detailCalls).toHaveLength(1);
});

test("재조회 중에도 필터를 유지하고 새 응답에 적용한다", async ({ page, gateway }) => {
  await enter(page, gateway);
  await page.getByLabel("기록 조건").selectOption("error");
  gateway.hold(2);
  gateway.reply(2, { body: { ...records(), events: [records().events[0]] } });
  await page.getByRole("button", { name: "비행기록 다시 조회", exact: true }).click();
  await expect.poll(() => gateway.detailCalls.length).toBe(2);
  await expect(page.getByRole("button", { name: "CSV 내보내기", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByLabel("기록 조건")).toHaveValue("error");
  gateway.release(2);
  await expect(page.getByText("조건에 맞는 수신 기록이 없습니다.")).toBeVisible();
  await expect(page.getByRole("status", { name: "세션 기록 표시 범위" })).toContainText(
    "수신 1건 중 0건 표시",
  );
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}px 기록 필터와 타임라인 접근성`, async ({ page, gateway }) => {
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 1000 });
      await enter(page, gateway);
      const kind = page.getByLabel("요청 유형");
      await kind.focus();
      await page.keyboard.press("Tab");
      await expect(page.getByLabel("기록 조건")).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByLabel("기록 조건")).toHaveValue("error");
      await expect(page.getByRole("list", { name: "표시 중인 세션 기록" })).toContainText(
        "HTTP 200 · 오류 기록",
      );
      await page.keyboard.press("Tab");
      await expect(page.getByLabel("표시 순서")).toBeFocused();
      await page.mouse.move(0, 0);
      await expect(page.locator(".flight-event-filters")).toHaveScreenshot(
        `session-record-filters-${theme}-${width}.png`,
      );
      await expect(page.getByRole("list", { name: "표시 중인 세션 기록" })).toHaveScreenshot(
        `session-record-events-${theme}-${width}.png`,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
        ).axe;
        return (await axe.run(document)).violations.map((item) => item.id);
      });
      expect(violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(new URL(page.url()).searchParams.has("session_id")).toBe(false);
    });
  }
}

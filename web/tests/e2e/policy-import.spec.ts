import { expect, type Page } from "@playwright/test";
import { test, account, policy, exportDocument } from "./fixtures/policy-import";

const panel = (page: Page) => page.getByRole("dialog", { name: "정책 가져오기", exact: true });
const trigger = (page: Page) => page.getByRole("button", { name: "정책 가져오기", exact: true });
const plan = (page: Page) => panel(page).getByRole("button", { name: "서버 계획 확인", exact: true });
const apply = (page: Page) => panel(page).getByRole("button", { name: "검토한 정책 적용", exact: true });
const refresh = (page: Page) => panel(page).getByRole("button", { name: "현재 내용 다시 조회", exact: true });
const success = "정책 가져오기 적용 응답을 확인했습니다.";
const uncertain = "적용 여부를 확인할 수 없습니다.";
const body = { policies: [{ ...policy, name: "가져온 공개 정책", rules: [] }] };
async function login(page: Page) {
  await page.goto("login?return_to=%2Fapp%2Fgovernance%2Fpolicies%3Ftab%3Dsafety");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(trigger(page)).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();
}
async function file(page: Page, content = JSON.stringify(body), name = "public-policy.json") {
  await panel(page)
    .getByLabel("정책 JSON 파일", { exact: true })
    .evaluate(
      (input, selected) => {
        const files = new DataTransfer();
        files.items.add(new File([selected.content], selected.name, { type: "application/json" }));
        (input as HTMLInputElement).files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { content, name },
    );
}
async function review(page: Page, content = JSON.stringify(body)) {
  await file(page, content);
  await plan(page).click();
  await expect(
    panel(page).getByRole("heading", { name: "서버 계획과 변경 내용", exact: true }),
  ).toBeFocused();
}
async function confirm(page: Page) {
  await panel(page).getByLabel("확인 문구", { exact: true }).fill("정책 가져오기");
  for (const name of [/^사용 상태인 정책/u, /^표시된 기존 규칙 제거/u, /^보호된 값을 표시/u]) {
    const checkbox = panel(page).getByRole("checkbox", { name });
    if (await checkbox.count()) await checkbox.check();
  }
  await expect(apply(page)).toBeEnabled();
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function violations(page: Page) {
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (root: Document) => Promise<{
            violations: { id: string; impact: string | null; nodes: { target: string[] }[] }[];
          }>;
        };
      }
    ).axe;
    return (await axe.run(document)).violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    }));
  });
}

test("서버 계획·규칙 제거·확인 문구를 검토한 뒤 한 번만 적용하고 초점을 복원한다", async ({
  page,
  imports,
}) => {
  await login(page);
  await review(page);
  expect(imports.applies).toEqual([]);
  expect(imports.dryRuns).toEqual([body]);
  await expect(panel(page)).toContainText("모든 규칙 제거 · 제거되는 기존 규칙 2개");
  await expect(apply(page)).toBeDisabled();
  await apply(page).evaluate((node) => (node as HTMLButtonElement).click());
  expect(imports.applies).toEqual([]);
  await panel(page).getByLabel("확인 문구", { exact: true }).fill("정책 가져오기");
  await expect(apply(page)).toBeDisabled();
  await confirm(page);
  await apply(page).click();
  await expect(panel(page).getByText(success, { exact: true })).toBeVisible();
  expect(imports.applies).toEqual([body]);
  expect(imports.bodies).toEqual([JSON.stringify(body)]);
  await expect.poll(() => imports.exports()).toBe(3);
  await panel(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(panel(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  await expect(page.getByRole("button", { name: "가져온 공개 정책 초안 편집", exact: true })).toBeVisible();
});

test("생략 규칙 보존과 미지의 중첩값을 구분하며 표시 보호 문구를 저장하지 않는다", async ({
  page,
  imports,
}) => {
  const secret = "corp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const nested = {
    policies: [
      {
        id: policy.id,
        name: "중첩값 보존",
        enabled: false,
        rules: [
          {
            id: "new-public-rule",
            conditions: { future_filter: { MixedCase: ["keep", 0.1, null] } },
            actions: {
              future_action: Object.fromEntries([
                ["credential", secret],
                ["__proto__", "public-prototype-data"],
              ]),
            },
          },
        ],
      },
    ],
  };
  await login(page);
  await review(page, JSON.stringify({ policies: [{ id: policy.id, name: "규칙 보존" }] }));
  await expect(panel(page)).toContainText("기존 규칙 유지 · 제거되는 기존 규칙 0개");
  await panel(page).getByRole("button", { name: "다시 검토", exact: true }).click();
  await review(page, JSON.stringify(nested));
  await expect(panel(page)).not.toContainText(secret);
  await confirm(page);
  await apply(page).click();
  await expect(panel(page)).toContainText(success);
  expect(imports.applies).toEqual([nested]);
  expect(imports.bodies[0]).toContain(secret);
});

for (const invalid of [
  '{"policies":[],"policies":[]}',
  '{"policies":[{"id":"invalid","name":"공개","rules":[{"id":"r","actions":{"number":9007199254740993}}]}]}',
  '{"policies":[{"id":"invalid","name":"공개","unsupported":true}]}',
]) {
  test(`로컬 검증 실패는 계획·적용 요청을 보내지 않는다: ${invalid.length}`, async ({ page, imports }) => {
    await login(page);
    await file(page, invalid);
    await expect(panel(page).getByText("확인이 필요합니다.", { exact: true })).toBeVisible();
    await expect(plan(page)).toBeHidden();
    expect(imports.dryRuns).toEqual([]);
    expect(imports.applies).toEqual([]);
    expect(imports.exports()).toBe(0);
  });
}

for (const mode of ["flag", "status"] as const) {
  test(`${mode} 읽기 전용은 로컬 파일 확인만 허용하고 변조 클릭도 서버 POST를 막는다`, async ({
    page,
    gateway,
    imports,
  }) => {
    gateway.readonly(mode);
    await login(page);
    await file(page);
    await expect(plan(page)).toBeDisabled();
    await plan(page).evaluate((node) => {
      node.removeAttribute("aria-disabled");
      (node as HTMLButtonElement).click();
    });
    await expect(panel(page)).toContainText("서버 검증과 적용을 실행할 수 없습니다.");
    expect(imports.dryRuns).toEqual([]);
    expect(imports.applies).toEqual([]);
    expect(imports.exports()).toBe(0);
  });
}

test("저장 전 기준이 바뀌면 다시 검토하게 하며 기존 승인을 재사용하지 않는다", async ({ page, imports }) => {
  await login(page);
  await review(page);
  await confirm(page);
  imports.rows([{ ...policy, name: "공개 편집 정책", description: "다른 관리자의 변경" }]);
  await apply(page).click();
  await expect(panel(page)).toContainText("현재 정책이 바뀌었습니다. 서버 계획부터 다시 검토하세요.");
  await expect(apply(page)).toBeHidden();
  expect(imports.applies).toEqual([]);
  await plan(page).click();
  await expect(panel(page).getByLabel("확인 문구", { exact: true })).toHaveValue("");
  await expect(apply(page)).toBeDisabled();
});

test("저장 전 조회 중 권한 회수는 계획 승인이 있어도 적용을 차단한다", async ({ page, imports, gateway }) => {
  await login(page);
  await review(page);
  await confirm(page);
  imports.holdExport(2);
  await apply(page).click();
  await expect.poll(() => imports.exports()).toBe(2);
  gateway.writable(false);
  await runtime(page);
  imports.releaseExport(2);
  await expect(panel(page).getByRole("button", { name: "취소", exact: true })).toBeEnabled();
  await expect(panel(page)).toContainText("서버 검증과 적용을 실행할 수 없습니다.");
  expect(imports.applies).toEqual([]);
});

test("동기 재클릭과 적용 중 닫기는 요청을 늘리지 않는다", async ({ page, imports }) => {
  imports.holdApply(1);
  await login(page);
  await review(page);
  await confirm(page);
  await apply(page).evaluate((node) => {
    (node as HTMLButtonElement).click();
    (node as HTMLButtonElement).click();
  });
  await expect.poll(() => imports.applies.length).toBe(1);
  await page.keyboard.press("Escape");
  await panel(page).getByRole("button", { name: "대화상자 닫기", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  imports.releaseApply(1);
  await expect(panel(page)).toContainText(success);
  expect(imports.applies).toEqual([body]);
});

test("미확정 응답은 자동 재전송하지 않고 원본 재조회와 새로운 승인을 요구한다", async ({ page, imports }) => {
  imports.reply(1, { body: {}, commit: false });
  await login(page);
  await review(page);
  await confirm(page);
  await apply(page).click();
  await expect(panel(page)).toContainText(uncertain);
  await expect(apply(page)).toBeDisabled();
  await expect(panel(page).getByLabel("정책 JSON 파일", { exact: true })).toBeDisabled();
  await apply(page).evaluate((node) => (node as HTMLButtonElement).click());
  expect(imports.applies).toEqual([body]);
  await refresh(page).click();
  await expect(panel(page)).toContainText("이전 승인은 폐기했으므로 서버 계획부터 다시 검토하세요.");
  await expect(apply(page)).toBeHidden();
  await plan(page).click();
  await expect(apply(page)).toBeDisabled();
  await confirm(page);
  await apply(page).click();
  await expect(panel(page)).toContainText(success);
  expect(imports.applies).toEqual([body, body]);
});

test("미확정 응답 뒤 실제 내용이 바뀌었으면 재조회로 재전송 잠금을 풀지 않는다", async ({
  page,
  imports,
}) => {
  imports.reply(1, { body: {}, commit: true });
  await login(page);
  await review(page);
  await confirm(page);
  await apply(page).click();
  await expect(panel(page)).toContainText(uncertain);
  await refresh(page).click();
  await expect(panel(page)).toContainText("다시 보내기는 잠겨 있습니다.");
  await expect(apply(page)).toBeDisabled();
  expect(imports.applies).toEqual([body]);
});

test("적용 응답 이후 조회 실패는 성공을 뒤집거나 적용을 재전송하지 않는다", async ({ page, imports }) => {
  imports.failFollowup(true);
  await login(page);
  await review(page);
  await confirm(page);
  await apply(page).click();
  await expect(panel(page)).toContainText(success);
  await expect(panel(page)).toContainText("적용 응답은 확인했지만 현재 목록 조회를 마치지 못했습니다.");
  await expect(apply(page)).toBeHidden();
  imports.failFollowup(false);
  await refresh(page).click();
  await expect(panel(page)).not.toContainText("적용 응답은 확인했지만 현재 목록 조회를 마치지 못했습니다.");
  expect(imports.applies).toEqual([body]);
});

test("명시적 민감정보 확인 후 백업 원문 바이트를 숫자 손실 없이 내려받는다", async ({ page, imports }) => {
  const raw =
    JSON.stringify(
      exportDocument([
        {
          id: "backup",
          name: "공개 백업",
          rules: [{ id: "r", actions: { large: "public-large-number-token" } }],
        },
      ]),
      null,
      2,
    ).replace('"public-large-number-token"', "9007199254740993") + "\n";
  imports.rawExport(raw);
  await login(page);
  const downloadButton = panel(page).getByRole("button", { name: "현재 정책 백업 내려받기", exact: true });
  await expect(downloadButton).toBeDisabled();
  await panel(page)
    .getByRole("checkbox", { name: /^민감값을 포함할 수 있는 원문/u })
    .check();
  const download = page.waitForEvent("download");
  await downloadButton.click();
  const result = await download;
  expect(result.suggestedFilename()).toBe("policy-backup.json");
  const stream = await result.createReadStream();
  if (!stream) throw new Error("Expected completed policy download");
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new Error("Expected byte download chunk");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  expect(new TextDecoder().decode(bytes)).toBe(raw);
  expect(imports.applies).toEqual([]);
  expect(imports.dryRuns).toEqual([]);
});

test("좁은 화면에서도 확인과 취소를 사용할 수 있으며 비어 있는 창의 Escape 초점을 복원한다", async ({
  page,
  imports,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel(page).getByRole("button", { name: "취소", exact: true })).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      page.evaluate(() => ({
        fits: document.documentElement.scrollWidth <= window.innerWidth,
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        overflowing: [...document.querySelectorAll("body *")]
          .filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1)
          .slice(0, 12)
          .map((node) => ({
            tag: node.tagName,
            className: node.className,
            right: node.getBoundingClientRect().right,
          })),
      })),
    )
    .toMatchObject({ fits: true });
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    expect(await panel(page).evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  expect(imports.applies).toEqual([]);
});

test("긴 한글 정책 비교의 페이지 이동과 모바일 가로 경계·자동 접근성을 검증한다", async ({
  page,
  imports,
}) => {
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  const many = {
    policies: Array.from({ length: 21 }, (_, index) => ({
      id: `public-long-${index}`,
      name: `공개 정책 ${index + 1} ${"긴한글이름".repeat(20)}`,
      rules: [],
    })),
  };
  await review(page, JSON.stringify(many));
  await expect(panel(page)).toContainText("1 / 2쪽");
  await panel(page).getByRole("button", { name: "다음 정책", exact: true }).click();
  await expect(panel(page)).toContainText("2 / 2쪽");
  await expect(
    panel(page).getByRole("heading", { name: many.policies[20]?.name, exact: true }),
  ).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel(page).getByLabel("확인 문구", { exact: true }).scrollIntoViewIfNeeded();
  await expect(panel(page).getByLabel("확인 문구", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(apply(page)).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await violations(page)).toEqual([]);
  expect(imports.applies).toEqual([]);
});

test("모바일에서 한글 파일 선택과 검토 제목·적용 버튼 전체를 스크롤 없이 확인한다", async ({
  page,
  imports,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const chooser = page.waitForEvent("filechooser");
  await panel(page).getByRole("button", { name: "JSON 파일 선택", exact: true }).click();
  expect(await (await chooser).element().getAttribute("type")).toBe("file");
  await review(page);
  await expect(
    panel(page).getByRole("heading", { name: "서버 계획과 변경 내용", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(apply(page)).toBeInViewport({ ratio: 1 });
  await expect(apply(page)).toBeDisabled();
  await confirm(page);
  await expect(panel(page).getByLabel("확인 문구", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(apply(page)).toBeInViewport({ ratio: 1 });
  expect(
    await apply(page).evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }),
  ).toBe(true);
  expect(imports.applies).toEqual([]);
});

test("다른 주체로 바뀌었다 돌아와도 지연된 백업은 내려받지 않고 새 확인만 허용한다", async ({
  page,
  gateway,
  imports,
}) => {
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  imports.holdExport(1);
  await login(page);
  await panel(page)
    .getByRole("checkbox", { name: /^민감값을 포함할 수 있는 원문/u })
    .check();
  await panel(page).getByRole("button", { name: "현재 정책 백업 내려받기", exact: true }).click();
  await expect.poll(() => imports.exports()).toBe(1);
  gateway.owner("public-other-importer");
  await runtime(page);
  await expect(panel(page)).toBeHidden();
  gateway.owner(account.id);
  await runtime(page);
  imports.releaseExport(1);
  await expect.poll(() => imports.finishedExports).toEqual([1]);
  expect(downloads).toEqual([]);
  await trigger(page).click();
  await expect(
    panel(page).getByRole("button", { name: "현재 정책 백업 내려받기", exact: true }),
  ).toBeDisabled();
  await panel(page)
    .getByRole("checkbox", { name: /^민감값을 포함할 수 있는 원문/u })
    .check();
  const download = page.waitForEvent("download");
  await panel(page).getByRole("button", { name: "현재 정책 백업 내려받기", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("policy-backup.json");
  expect(downloads).toEqual(["policy-backup.json"]);
  expect(imports.applies).toEqual([]);
});

test("필수 현재값이 누락된 내보내기는 백업 다운로드와 서버 계획의 기준으로 쓰지 않는다", async ({
  page,
  imports,
}) => {
  const incomplete = exportDocument([policy]);
  const first = incomplete.policies[0];
  if (!first) throw new Error("Expected synthetic exported policy");
  Reflect.deleteProperty(first, "enabled");
  imports.rawExport(JSON.stringify(incomplete));
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await login(page);
  await panel(page)
    .getByRole("checkbox", { name: /^민감값을 포함할 수 있는 원문/u })
    .check();
  await panel(page).getByRole("button", { name: "현재 정책 백업 내려받기", exact: true }).click();
  await expect(panel(page).getByText("확인이 필요합니다.", { exact: true })).toBeVisible();
  expect(downloads).toEqual([]);
  await file(page);
  await plan(page).click();
  await expect(panel(page).getByText("확인이 필요합니다.", { exact: true })).toBeVisible();
  expect(imports.dryRuns).toEqual([]);
  expect(imports.applies).toEqual([]);
  expect(imports.exports()).toBe(2);
});

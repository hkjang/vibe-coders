// 가이드 화면 캡처 드라이버.
//
// scripts/guide-screenshots.sh 가 일회용 게이트웨이를 띄운 뒤 이 스크립트를 부른다.
// 대상 주소·계정은 캡처 전용 환경 변수로만 받고, 하나라도 없으면 그 자리에서 멈춘다.
// 화면을 읽기만 하고 설정은 바꾸지 않는다 — 상태를 만드는 일은 셸 스크립트가
// 버려도 되는 임시 DB 위에서 한다.
//
//   GUIDE_CAPTURE_BASE_URL   게이트웨이 주소 (루프백만 허용; 다른 호스트는 GUIDE_CAPTURE_DISPOSABLE=1 필요)
//   GUIDE_CAPTURE_EMAIL      로그인 이메일
//   GUIDE_CAPTURE_PASSWORD   로그인 비밀번호
//   GUIDE_CAPTURE_OUT        PNG 를 쓸 디렉터리
//   GUIDE_CAPTURE_BROWSER    (선택) Chrome 실행 파일 경로. 없으면 Playwright 의 Chromium.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

function required(name) {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    console.error(`${name} 가 비어 있습니다. 캡처 전용 변수를 넘기세요.`);
    process.exit(2);
  }
  return value;
}

const baseURL = required("GUIDE_CAPTURE_BASE_URL").replace(/\/+$/, "");
const email = required("GUIDE_CAPTURE_EMAIL");
const password = required("GUIDE_CAPTURE_PASSWORD");
const outDir = required("GUIDE_CAPTURE_OUT");

const host = new URL(baseURL).hostname;
if (!["127.0.0.1", "localhost", "::1"].includes(host) && process.env.GUIDE_CAPTURE_DISPOSABLE !== "1") {
  console.error(
    `${baseURL} 은 루프백이 아닙니다. 버려도 되는 배포가 맞으면 GUIDE_CAPTURE_DISPOSABLE=1 을 함께 넘기세요.`,
  );
  process.exit(2);
}

// <화면>-<상태>.png — 파일명은 GUIDE-STANDARD 의 규칙을 따른다.
const shots = [
  { file: "login", path: "/app/login", anonymous: true },
  { file: "overview", path: "/app/overview" },
  { file: "me-home", path: "/app/me" },
  { file: "team-dashboard", path: "/app/team" },
  { file: "gateway-health", path: "/app/gateway/health" },
  { file: "gateway-providers", path: "/app/gateway/providers" },
  { file: "gateway-models", path: "/app/gateway/models" },
  { file: "gateway-chat", path: "/app/gateway/chat" },
  { file: "routing-rules", path: "/app/routing/rules" },
  { file: "observability-requests", path: "/app/observability/requests" },
  { file: "observability-traces", path: "/app/observability/traces" },
  { file: "observability-sessions", path: "/app/observability/sessions" },
  { file: "observability-xview", path: "/app/observability/xview" },
  { file: "observability-llm", path: "/app/observability/llm" },
  { file: "prompts-library", path: "/app/prompts/library" },
  { file: "access-users", path: "/app/access/users" },
  { file: "governance-policies", path: "/app/governance/policies" },
  { file: "governance-reports", path: "/app/governance/reports" },
  { file: "mcp", path: "/app/mcp" },
  { file: "agents-skills", path: "/app/agents/skills" },
  { file: "finops", path: "/app/finops" },
  { file: "security", path: "/app/security" },
  { file: "system-health", path: "/app/system/health" },
  { file: "system-settings", path: "/app/system/settings" },
];

async function settle(page) {
  await page.waitForLoadState("networkidle");
  // 스켈레톤이 박제된 캡처는 다시 찍는다: 로딩 상태가 모두 사라질 때까지 기다린다.
  // eslint-disable-next-line no-undef -- 브라우저 안에서 실행된다
  await page.waitForFunction(() => document.querySelectorAll(".page-state .skeleton").length === 0, null, {
    timeout: 20_000,
  });
  await page.waitForTimeout(400);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const executablePath = (process.env.GUIDE_CAPTURE_BROWSER ?? "").trim() || undefined;
  const browser = await chromium.launch({ executablePath });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    baseURL,
  });
  const page = await context.newPage();
  const failures = [];

  try {
    for (const shot of shots) {
      if (shot.anonymous) {
        await context.clearCookies();
        await page.goto(shot.path);
        await settle(page);
      } else {
        await page.goto(shot.path);
        // 인증 설정을 받아오기 전에는 로그인 폼도 앱 셸도 없다 — 둘 중 하나가 뜰 때까지 기다린다.
        await page.locator("#login-email, .sidebar-nav").first().waitFor({ timeout: 15_000 });
        // 로그인 화면이 뜨면 폼으로 로그인한다 — 세션 저장소는 탭 안에서 유지된다.
        if (await page.locator("#login-email").count()) {
          await page.fill("#login-email", email);
          await page.fill("#login-password", password);
          await page.click("button[type=submit]");
          await page.waitForURL((url) => !url.pathname.endsWith("/app/login"), { timeout: 15_000 });
          if (!page.url().includes(shot.path)) await page.goto(shot.path);
        }
        await settle(page);
      }
      if (await page.locator('[role="alert"].page-state-error').count()) {
        failures.push(`${shot.file}: 화면이 오류 상태입니다`);
      }
      const file = path.join(outDir, `${shot.file}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`captured ${shot.file}.png (${page.url()})`);
    }
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

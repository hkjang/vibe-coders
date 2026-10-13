import { describe, expect, it } from "vitest";
import tokens from "./tokens.css?raw";
import foundation from "./foundation.css?raw";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

describe("상태 알림 디자인 토큰", () => {
  it.each(["light", "dark"])("%s 알림의 일반 크기 텍스트 대비가 4.5:1 이상이다", (theme) => {
    const blocks = [...tokens.matchAll(/:root(?:\[data-theme="dark"\])?\s*\{([^}]+)\}/gu)];
    const values = Object.fromEntries(
      [
        ...(blocks[theme === "light" ? 0 : 1]?.[1] ?? "").matchAll(/--color-([a-z-]+): (#[a-f0-9]{6});/gu),
      ].map((match) => [match[1], match[2]]),
    );
    for (const name of ["success", "info", "warning", "danger"]) {
      const foreground = values[name];
      const background = values[`${name}-soft`];
      expect(foreground).toMatch(/^#[a-f0-9]{6}$/u);
      expect(background).toMatch(/^#[a-f0-9]{6}$/u);
      const a = luminance(foreground ?? "");
      const b = luminance(background ?? "");
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("알림 라이브러리의 테마 선택자보다 높은 우선순위로 상태 색을 재사용한다", () => {
    const rule = foundation.match(
      /\[data-sonner-toaster\]\.app-toaster\[data-sonner-theme\]\s*\{([^}]+)\}/u,
    )?.[1];
    for (const [type, token] of [
      ["success", "success"],
      ["info", "info"],
      ["warning", "warning"],
      ["error", "danger"],
    ]) {
      expect(rule).toContain(`--${type}-bg: var(--color-${token}-soft)`);
      expect(rule).toContain(`--${type}-text: var(--color-${token})`);
    }
  });
});

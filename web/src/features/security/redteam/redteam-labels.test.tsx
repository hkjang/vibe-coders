import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  riskLabel,
  expectedPolicyLabel,
  evaluatorTypeLabel,
  targetTypeLabel,
  probeCategoryLabel,
} from "./redteam-labels";

const helpers = { riskLabel, expectedPolicyLabel, evaluatorTypeLabel, targetTypeLabel, probeCategoryLabel };
describe.each(Object.entries(helpers))("%s의 사용자 정의 식별자 보존", (_name, format) => {
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "%s를 상속 속성이 아닌 문자열로 표시한다",
    (value) => {
      expect(format(value)).toBe(value);
      render(<p>{format(value)}</p>);
      expect(screen.getByText(value)).toBeVisible();
    },
  );
});

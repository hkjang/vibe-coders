import { describe, expect, it } from "vitest";

import { actionLabels, conditionLabels, policyDecisionLabel } from "./policy-labels";

describe("정책 표시 이름", () => {
  it("조건·동작 코드와 한글 이름을 분리한다", () => {
    expect(conditionLabels.contains_secret).toBe("비밀정보 포함");
    expect(conditionLabels.complexity_score).toBe("복잡도 점수");
    expect(actionLabels.secret_mask).toBe("비밀정보 가리기");
    expect(actionLabels.deny_models).toBe("모델 차단");
    expect(actionLabels.allow_providers).toBe("공급자 허용");
  });

  it("알려진 판단은 번역하고 새 서버 판단은 다른 의미로 바꾸지 않는다", () => {
    expect(policyDecisionLabel("allow")).toBe("허용");
    expect(policyDecisionLabel("block")).toBe("차단");
    expect(policyDecisionLabel("require_approval")).toBe("승인 필요");
    expect(policyDecisionLabel("future_decision")).toBe("future_decision");
    expect(policyDecisionLabel(undefined)).toBe("—");
  });
});

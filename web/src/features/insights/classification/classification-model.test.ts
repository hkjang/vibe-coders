import { describe, expect, it } from "vitest";

import {
  workReviewQuerySchema,
  type WorkCategory,
  type WorkPolicyConfig,
} from "@/shared/api/domains/insights-classification";

import {
  addCategory,
  assignableCategories,
  baselineProblems,
  baselineSaving,
  buildCategoryTree,
  canonicalCategoryId,
  categoryCounts,
  categoryIdProblem,
  categoryOptions,
  categoryPath,
  changeDetails,
  changeSummary,
  childCategoryId,
  configFingerprint,
  countNodes,
  daysRebuiltCount,
  defaultReclassifyPeriod,
  diffPolicy,
  filterCategoryTree,
  formatLag,
  isDay,
  issueAt,
  issueCategoryId,
  issueLocation,
  issueTab,
  jobFinished,
  jobPollInterval,
  jobProgress,
  joinList,
  localIssues,
  mergeCandidates,
  mergedSources,
  methodDistribution,
  newCategory,
  reclassifyConflictKind,
  reclassifyFormFromParams,
  reclassifyFormProblem,
  reclassifyQuery,
  removalImpact,
  removeCategory,
  renameCategoryId,
  reviewFiltersFromParams,
  reviewLastPage,
  reviewQuery,
  seoulDay,
  slugSegment,
  splitList,
  updateCategory,
} from "./classification-model";

function category(id: string, name: string, extra: Partial<WorkCategory> = {}): WorkCategory {
  return { ...newCategory(id, id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "", name), ...extra };
}

function policy(categories: WorkCategory[], extra: Partial<WorkPolicyConfig> = {}): WorkPolicyConfig {
  return {
    categories,
    action_types: [{ id: "create", name: "생성", keywords: ["만들어"] }],
    thresholds: { accept: 0.72, review_below: 0.5, min_evidence: 2, min_group_size: 3 },
    llm: { system_prompt: "분류하세요.", max_input_chars: 1500 },
    baselines: [],
    ...extra,
  };
}

const base = policy([
  category("dev", "소프트웨어 개발"),
  category("dev.codegen", "코드 생성", {
    rules: { ...newCategory("x", "", "").rules, keywords: ["함수", "api"] },
  }),
  category("dev.codegen.api", "API 코드"),
  category("dev.review", "코드 리뷰"),
  category("infra", "IT 인프라 운영"),
  category("infra.k8s", "쿠버네티스", { enabled: false }),
  category("other", "기타 및 미분류"),
]);

describe("category ids", () => {
  it("makes an id segment from a name", () => {
    expect(slugSegment("API Code Gen")).toBe("api-code-gen");
    expect(slugSegment("  Café/Bar  ")).toBe("cafe-bar");
    expect(slugSegment("__private")).toBe("private");
    expect(slugSegment("코드 생성")).toBe("");
    expect(slugSegment("x".repeat(60))).toHaveLength(40);
  });

  it("puts a new id under its parent and keeps it unique", () => {
    const taken = new Set(["dev", "dev.codegen", "dev.codegen-2"]);
    expect(childCategoryId("dev", "Codegen", taken)).toBe("dev.codegen-3");
    expect(childCategoryId("dev", "Unit Test", taken)).toBe("dev.unit-test");
    expect(childCategoryId("dev", "단위 테스트", taken)).toBe("dev.category");
    expect(childCategoryId("", "Research", taken)).toBe("research");
  });

  it("explains why an id is not acceptable", () => {
    const taken = new Set(["dev", "dev.codegen"]);
    expect(categoryIdProblem("dev.unit-test", "dev", taken)).toBeUndefined();
    expect(categoryIdProblem("", "dev", taken)).toBe("ID를 입력하세요.");
    expect(categoryIdProblem("infra.unit", "dev", taken)).toContain("'dev.'로 시작");
    expect(categoryIdProblem("dev.a.b", "dev", taken)).toContain("한 단계 아래");
    expect(categoryIdProblem("dev.Unit", "dev", taken)).toContain("영문 소문자");
    expect(categoryIdProblem("dev.-x", "dev", taken)).toContain("영문 소문자");
    expect(categoryIdProblem("dev.codegen", "dev", taken)).toBe("이미 있는 ID입니다.");
    expect(categoryIdProblem("a.b", "", taken)).toContain("점을 쓸 수 없습니다");
    expect(categoryIdProblem("research", "", taken)).toBeUndefined();
    // A fourth level is refused by the pattern even under a valid third-level parent.
    expect(categoryIdProblem("a.b.c.d", "a.b.c", taken)).toContain("최대 3단계");
  });
});

describe("category tree", () => {
  it("builds the hierarchy with positions and descendant counts", () => {
    const tree = buildCategoryTree(base.categories);
    expect(tree.map((node) => node.category.id)).toEqual(["dev", "infra", "other"]);
    const dev = tree[0];
    expect(dev?.descendants).toBe(3);
    expect(dev?.children.map((node) => [node.category.id, node.level, node.index])).toEqual([
      ["dev.codegen", 2, 1],
      ["dev.review", 2, 3],
    ]);
    expect(dev?.children[0]?.children[0]?.category.id).toBe("dev.codegen.api");
    expect(countNodes(tree)).toBe(7);
  });

  it("keeps a category whose parent is missing reachable", () => {
    const tree = buildCategoryTree([category("dev", "개발"), category("ghost.child", "고아")]);
    expect(tree.map((node) => node.category.id)).toEqual(["dev", "ghost.child"]);
  });

  it("counts by level and state", () => {
    expect(categoryCounts(base.categories)).toEqual({
      total: 7,
      top: 3,
      middle: 3,
      leaf: 1,
      disabled: 1,
      merged: 0,
    });
  });

  it("filters by name, id or keyword and keeps the ancestors", () => {
    const tree = buildCategoryTree(base.categories);
    const byKeyword = filterCategoryTree(tree, "함수");
    expect(byKeyword.map((node) => node.category.id)).toEqual(["dev"]);
    expect(byKeyword[0]?.children.map((node) => node.category.id)).toEqual(["dev.codegen"]);
    expect(byKeyword[0]?.children[0]?.children).toEqual([]);
    expect(filterCategoryTree(tree, "K8S").map((node) => node.category.id)).toEqual(["infra"]);
    expect(filterCategoryTree(tree, "리뷰")[0]?.children.map((node) => node.category.id)).toEqual([
      "dev.review",
    ]);
    expect(filterCategoryTree(tree, "없는말")).toEqual([]);
    expect(filterCategoryTree(tree, "  ")).toHaveLength(3);
  });

  it("lists options by path and leaves out what cannot be assigned", () => {
    const options = categoryOptions(base.categories);
    expect(options.find((option) => option.id === "dev.codegen.api")?.path).toBe(
      "소프트웨어 개발 › 코드 생성 › API 코드",
    );
    const assignable = assignableCategories(
      updateCategory(base, "dev.review", { merged_into: "dev.codegen" }).categories,
    ).map((option) => option.id);
    expect(assignable).not.toContain("infra.k8s");
    expect(assignable).not.toContain("dev.review");
    expect(assignableCategories(base.categories, "인프라").map((option) => option.id)).toEqual(["infra"]);
    expect(categoryPath(base.categories, "dev.codegen.zzz")).toEqual(["소프트웨어 개발", "코드 생성", "zzz"]);
  });
});

describe("merging", () => {
  it("offers same-level categories that are not merged themselves", () => {
    const merged = updateCategory(base, "infra.k8s", { merged_into: "dev.review" });
    expect(mergeCandidates(merged.categories, "dev.codegen").map((c) => c.id)).toEqual(["dev.review"]);
    expect(mergeCandidates(merged.categories, "dev").map((c) => c.id)).toEqual(["infra", "other"]);
    expect(mergeCandidates(merged.categories, "other")).toEqual([]);
    expect(mergedSources(merged.categories, "dev.review").map((c) => c.id)).toEqual(["infra.k8s"]);
    expect(canonicalCategoryId(merged.categories, "infra.k8s")).toBe("dev.review");
    expect(canonicalCategoryId(merged.categories, "dev.codegen")).toBe("dev.codegen");
  });
});

describe("editing the draft", () => {
  it("adds a child after its parent's last descendant", () => {
    const next = addCategory(base, newCategory("dev.test", "dev", " 테스트 작성 "));
    expect(next.categories.map((c) => c.id)).toEqual([
      "dev",
      "dev.codegen",
      "dev.codegen.api",
      "dev.review",
      "dev.test",
      "infra",
      "infra.k8s",
      "other",
    ]);
    expect(next.categories[4]?.name).toBe("테스트 작성");
    expect(addCategory(base, newCategory("research", "", "연구")).categories.at(-1)?.id).toBe("research");
  });

  it("renames an unsaved category together with what refers to it", () => {
    const draft = policy(
      [
        category("dev", "개발"),
        category("dev.new", "새 분류"),
        category("dev.new.sub", "하위"),
        category("dev.old", "예전", { merged_into: "dev.new" }),
      ],
      {
        baselines: [
          { category_id: "dev.new", manual_minutes: 60, ai_minutes: 15, hourly_cost_krw: 50000, note: "" },
        ],
      },
    );
    const next = renameCategoryId(draft, "dev.new", "dev.codegen");
    expect(next.categories.map((c) => [c.id, c.parent_id, c.merged_into])).toEqual([
      ["dev", "", ""],
      ["dev.codegen", "dev", ""],
      ["dev.codegen.sub", "dev.codegen", ""],
      ["dev.old", "dev", "dev.codegen"],
    ]);
    expect(next.baselines[0]?.category_id).toBe("dev.codegen");
  });

  it("refuses to remove required or saved parent categories and explains a removal", () => {
    const saved = new Set(base.categories.map((c) => c.id));
    expect(removalImpact(base, "dev", saved).blocked).toContain("기본 대분류");
    expect(removalImpact(base, "other", saved).blocked).toContain("기타 및 미분류");
    expect(removalImpact(base, "dev.codegen", saved).blocked).toContain("하위 카테고리");
    expect(removalImpact(base, "dev.review", saved)).toMatchObject({ saved: true, descendants: 0 });
    expect(removalImpact(base, "dev.review", saved).blocked).toBeUndefined();

    const draft = addCategory(
      addCategory(base, newCategory("dev.fresh", "dev", "새 분류")),
      newCategory("dev.fresh.sub", "dev.fresh", "하위"),
    );
    const withRefs = updateCategory(
      {
        ...draft,
        baselines: [
          { category_id: "dev.fresh.sub", manual_minutes: 30, ai_minutes: 5, hourly_cost_krw: 1, note: "" },
        ],
      },
      "dev.review",
      { merged_into: "dev.fresh" },
    );
    expect(removalImpact(withRefs, "dev.fresh", saved)).toEqual({
      saved: false,
      descendants: 1,
      unmerged: ["dev.review"],
      baselines: 1,
    });
    const removed = removeCategory(withRefs, "dev.fresh");
    expect(removed.categories.map((c) => c.id)).toEqual(base.categories.map((c) => c.id));
    expect(removed.categories.find((c) => c.id === "dev.review")?.merged_into).toBe("");
    expect(removed.baselines).toEqual([]);
  });

  it("splits lists and compares documents by content", () => {
    expect(splitList("a, b\n b ,, A , c d ")).toEqual(["a", "b", "c d"]);
    expect(splitList("첫째, 문장\n둘째 문장", "lines")).toEqual(["첫째, 문장", "둘째 문장"]);
    expect(joinList(["a", "b"])).toBe("a, b");
    expect(joinList(["a", "b"], "lines")).toBe("a\nb");
    const reordered = {
      baselines: base.baselines,
      llm: base.llm,
      thresholds: base.thresholds,
      action_types: base.action_types,
      categories: base.categories,
    };
    expect(configFingerprint(reordered)).toBe(configFingerprint(base));
    expect(configFingerprint(updateCategory(base, "dev", { name: "개발" }))).not.toBe(
      configFingerprint(base),
    );
  });
});

describe("change summary", () => {
  it("counts what a save would change, like the server's version diff", () => {
    let draft = addCategory(base, newCategory("dev.test", "dev", "테스트 작성"));
    draft = addCategory(draft, newCategory("dev.docs", "dev", "문서화"));
    draft = updateCategory(draft, "dev.codegen", { rules: { keywords: ["api", "함수", "클래스"] } });
    draft = updateCategory(draft, "infra", { name: "인프라 운영" });
    draft = updateCategory(draft, "infra.k8s", { merged_into: "dev.review" });
    draft = { ...draft, thresholds: { ...draft.thresholds, accept: 0.8 } };
    expect(changeSummary(base, draft)).toEqual([
      "카테고리 추가 2",
      "이름 변경 1",
      "병합 1",
      "규칙 변경 1",
      "임계값 변경",
    ]);
    expect(diffPolicy(base, draft)).toMatchObject({
      added: ["dev.docs", "dev.test"],
      renamed: ["infra"],
      merged: ["infra.k8s"],
      rulesChanged: ["dev.codegen"],
    });
    expect(changeDetails(base, draft)).toEqual([
      "추가: 문서화 (dev.docs)",
      "추가: 테스트 작성 (dev.test)",
      "이름 변경: IT 인프라 운영 → 인프라 운영 (infra)",
      "병합: 쿠버네티스 (infra.k8s) → 코드 리뷰 (dev.review)",
      "규칙 변경: 코드 생성 (dev.codegen)",
      "임계값 확정 기준: 0.72 → 0.8",
    ]);
  });

  it("treats rule order as no change and the on/off switch as a rule change", () => {
    const reordered = updateCategory(base, "dev.codegen", { rules: { keywords: ["api", "함수"] } });
    expect(changeSummary(base, reordered)).toEqual([]);
    expect(changeSummary(base, updateCategory(base, "infra.k8s", { enabled: true }))).toEqual([
      "규칙 변경 1",
    ]);
    const merged = updateCategory(base, "infra.k8s", { merged_into: "dev.review" });
    expect(changeSummary(merged, base)).toEqual(["규칙 변경 1"]);
  });

  it("reports removals, descriptions, action types, the prompt and baselines", () => {
    const draft: WorkPolicyConfig = {
      ...updateCategory(removeCategory(base, "dev.review"), "dev", { description: "코드를 쓰고 고치는 일" }),
      action_types: [],
      llm: { ...base.llm, system_prompt: "다시 분류하세요." },
      baselines: [
        { category_id: "dev", manual_minutes: 60, ai_minutes: 15, hourly_cost_krw: 50000, note: "" },
      ],
    };
    expect(changeSummary(base, draft)).toEqual([
      "카테고리 삭제 1",
      "설명·예시 변경 1",
      "작업 유형 변경",
      "LLM 설정 변경",
      "기준값 변경 1",
    ]);
  });
});

describe("issues", () => {
  const config = policy(base.categories, {
    baselines: [{ category_id: "dev", manual_minutes: 60, ai_minutes: 15, hourly_cost_krw: 50000, note: "" }],
  });

  it("maps an issue path to its tab, category and readable place", () => {
    const keyword = {
      path: "categories[1].rules.keywords[7]",
      message: "키워드는 80바이트 이하여야 합니다.",
    };
    expect(issueTab(keyword)).toBe("categories");
    expect(issueCategoryId(keyword, config)).toBe("dev.codegen");
    expect(issueLocation(keyword, config)).toBe("카테고리 코드 생성 · 키워드 8번째");
    expect(issueLocation({ path: "categories[4].merged_into", message: "" }, config)).toBe(
      "카테고리 IT 인프라 운영 · 병합 대상",
    );
    expect(issueLocation({ path: "categories[99].name", message: "" }, config)).toBe("카테고리 100 · 이름");
    expect(issueLocation({ path: "categories", message: "" }, config)).toBe("카테고리");

    const threshold = { path: "thresholds.accept", message: "" };
    expect(issueTab(threshold)).toBe("policy");
    expect(issueCategoryId(threshold, config)).toBeUndefined();
    expect(issueLocation(threshold, config)).toBe("임계값 · 확정 기준");
    expect(issueLocation({ path: "llm.max_input_chars", message: "" }, config)).toBe("LLM · 입력 글자 수");
    expect(issueLocation({ path: "action_types[0].keywords[2]", message: "" }, config)).toBe(
      "작업 유형 생성 · 키워드 3번째",
    );
    expect(issueTab({ path: "action_types[0].id", message: "" })).toBe("policy");

    const baseline = { path: "baselines[0].manual_minutes", message: "" };
    expect(issueTab(baseline)).toBe("baselines");
    expect(issueLocation(baseline, config)).toBe("기준값 소프트웨어 개발 · 수동 처리 시간");
    expect(issueLocation({ path: "unknown.path", message: "" }, config)).toBe("unknown.path");
  });

  it("finds the issues of a field, including its list items", () => {
    const issues = [
      { path: "categories[1].rules.keywords[7]", message: "길다" },
      { path: "categories[1].name", message: "비었다" },
      { path: "categories[10].name", message: "다른 카테고리" },
    ];
    expect(issueAt(issues, "categories[1].rules.keywords")).toBe("길다");
    expect(issueAt(issues, "categories[1].name")).toBe("비었다");
    expect(issueAt(issues, "categories[1].description")).toBeUndefined();
  });

  it("finds problems it can see without the server, in the server's paths", () => {
    expect(localIssues(config)).toEqual([]);
    const broken: WorkPolicyConfig = {
      ...config,
      categories: [
        ...config.categories,
        category("dev.Bad Id", ""),
        category("ghost.child", "고아", { rules: { ...newCategory("x", "", "").rules, weight: 0 } }),
        category("other", "중복"),
      ],
      thresholds: { accept: 0.4, review_below: 0.5, min_evidence: 0, min_group_size: 3 },
      llm: { system_prompt: "x", max_input_chars: 50 },
      baselines: [{ category_id: "gone", manual_minutes: 0, ai_minutes: 5, hourly_cost_krw: -1, note: "" }],
    };
    expect(localIssues(broken).map((issue) => issue.path)).toEqual([
      "categories[7].id",
      "categories[7].name",
      "categories[8].parent_id",
      "categories[8].rules.weight",
      "categories[9].id",
      "thresholds.accept",
      "thresholds.min_evidence",
      "llm.max_input_chars",
      "baselines[0].manual_minutes",
      "baselines[0].hourly_cost_krw",
      "baselines[0].category_id",
    ]);
    expect(
      localIssues(updateCategory(config, "other", { enabled: false })).map((issue) => issue.path),
    ).toEqual(["categories[6].enabled"]);
  });

  it("validates a baseline and estimates its saving", () => {
    expect(baselineProblems({ manual_minutes: 60, ai_minutes: 15, hourly_cost_krw: 0 })).toEqual({});
    expect(Object.keys(baselineProblems({ manual_minutes: 0, ai_minutes: -1, hourly_cost_krw: -5 }))).toEqual(
      ["manual_minutes", "ai_minutes", "hourly_cost_krw"],
    );
    expect(baselineSaving({ manual_minutes: 60, ai_minutes: 15, hourly_cost_krw: 48000 })).toEqual({
      minutes: 45,
      costKrw: 36000,
    });
  });
});

describe("review queue", () => {
  it("reads the filters from the URL and ignores malformed values", () => {
    const filters = reviewFiltersFromParams(
      new URLSearchParams("status=unclassified&category=dev.codegen&max_conf=0.5&page=3"),
    );
    expect(filters).toEqual({ status: "unclassified", category: "dev.codegen", maxConf: 0.5, page: 3 });
    expect(reviewQuery(filters)).toEqual({
      status: "unclassified",
      category: "dev.codegen",
      max_conf: 0.5,
      limit: 50,
      offset: 100,
    });
    expect(reviewFiltersFromParams(new URLSearchParams("status=classified&max_conf=7&page=-2"))).toEqual({
      page: 1,
    });
    expect(reviewQuery(reviewFiltersFromParams(new URLSearchParams("max_conf=0")))).toEqual({
      max_conf: 0,
      limit: 50,
      offset: 0,
    });
    expect(reviewQuery(reviewFiltersFromParams(new URLSearchParams("")))).toEqual({ limit: 50, offset: 0 });
  });

  it("never asks for a page past the largest offset the server answers", () => {
    expect(reviewLastPage).toBe(2001);
    expect(reviewQuery(reviewFiltersFromParams(new URLSearchParams("page=2001")))).toEqual({
      limit: 50,
      offset: 100_000,
    });
    expect(reviewFiltersFromParams(new URLSearchParams("page=2002")).page).toBe(1);
    expect(workReviewQuerySchema.safeParse(reviewQuery({ page: 2001 })).success).toBe(true);
    expect(workReviewQuerySchema.safeParse({ offset: 100_050 }).success).toBe(false);
  });
});

describe("reclassify", () => {
  const now = new Date("2026-11-26T16:30:00Z"); // 2026-11-27 01:30 in Seoul

  it("uses Seoul days and defaults to the last week", () => {
    expect(seoulDay(now)).toBe("2026-11-27");
    expect(defaultReclassifyPeriod(now)).toEqual({ from: "2026-11-21", to: "2026-11-27" });
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("2026-2-9")).toBe(false);
  });

  it("turns the URL into a form and the form into a query", () => {
    const form = reclassifyFormFromParams(
      new URLSearchParams("from=2026-11-01&to=2026-11-10&status=review&category=dev&method=llm"),
      now,
    );
    expect(form).toEqual({
      from: "2026-11-01",
      to: "2026-11-10",
      status: "review",
      category: "dev",
      method: "llm",
    });
    expect(reclassifyQuery(form)).toEqual(form);
    const fallback = reclassifyFormFromParams(new URLSearchParams("from=nope&status=weird&method=x"), now);
    expect(fallback).toEqual({ from: "2026-11-21", to: "2026-11-27", status: "", category: "", method: "" });
    expect(reclassifyQuery(fallback)).toEqual({ from: "2026-11-21", to: "2026-11-27" });
  });

  it("checks the period before asking the server", () => {
    const form = { from: "2026-11-10", to: "2026-11-01", status: "", category: "", method: "" };
    expect(reclassifyFormProblem(form)).toBe("시작일이 종료일보다 늦습니다.");
    expect(reclassifyFormProblem({ ...form, from: "" })).toContain("YYYY-MM-DD");
    expect(reclassifyFormProblem({ ...form, from: "2025-01-01", to: "2026-11-01" })).toContain("최대 400일");
    expect(reclassifyFormProblem({ ...form, from: "2026-11-01", to: "2026-11-01" })).toBeUndefined();
  });

  it("names the three refusals of a run", () => {
    expect(reclassifyConflictKind("work_reclassify_expired")).toBe("expired");
    expect(reclassifyConflictKind("work_reclassify_conflict")).toBe("conflict");
    expect(reclassifyConflictKind("work_job_active")).toBe("job_active");
    expect(reclassifyConflictKind("work_policy_conflict")).toBeUndefined();
    expect(reclassifyConflictKind(undefined)).toBeUndefined();
  });

  it("knows when a job is finished and how far it is", () => {
    expect(["queued", "running"].map(jobFinished)).toEqual([false, false]);
    expect(["succeeded", "failed", "interrupted"].map(jobFinished)).toEqual([true, true, true]);
    expect(jobPollInterval(undefined)).toBe(2000);
    expect(jobPollInterval({ status: "running" }, 500)).toBe(500);
    expect(jobPollInterval({ status: "succeeded" })).toBe(false);
    expect(jobPollInterval({ status: "interrupted" })).toBe(false);

    const progress = {
      total: 200,
      done: 50,
      changed: 10,
      failed: 1,
      days_rebuilt: 2,
      kept_no_text: 0,
      previewed: 200,
    };
    expect(jobProgress({ status: "running", progress })).toEqual({ ratio: 0.25, percent: 25 });
    expect(jobProgress({ status: "running", progress: { ...progress, done: 900 } }).percent).toBe(100);
    expect(jobProgress({ status: "queued", progress: { ...progress, total: 0, done: 0 } }).percent).toBe(0);
    expect(jobProgress({ status: "succeeded", progress: { ...progress, total: 0, done: 0 } }).percent).toBe(
      100,
    );
    expect(daysRebuiltCount(3)).toBe(3);
    expect(daysRebuiltCount(["2026-11-25", "2026-11-26"])).toBe(2);
  });
});

describe("status", () => {
  it("formats the lag and the method distribution", () => {
    expect(formatLag(42)).toBe("42초");
    expect(formatLag(95)).toBe("1분 35초");
    expect(formatLag(7500)).toBe("2시간 5분");
    expect(formatLag(90000)).toBe("1일 1시간");
    expect(formatLag(-1)).toBe("—");
    const rows = methodDistribution({ rule: 60, cache: 30, llm: 10, embedding: 0 });
    expect(rows.map((row) => [row.method, row.label, row.count, row.share])).toEqual([
      ["rule", "규칙", 60, 0.6],
      ["llm", "LLM", 10, 0.1],
      ["cache", "캐시", 30, 0.3],
      ["manual", "수동 보정", 0, 0],
      ["embedding", "embedding", 0, 0],
    ]);
    expect(methodDistribution({}).every((row) => row.share === 0)).toBe(true);
  });
});

import type {
  WorkBaseline,
  WorkCategory,
  WorkJob,
  WorkPolicyConfig,
  WorkPolicyIssue,
  WorkReclassifyQuery,
  WorkReviewQuery,
  WorkReviewStatus,
  WorkRules,
} from "@/shared/api/domains/insights-classification";
import { workReviewStatuses } from "@/shared/api/domains/insights-classification";
import { workMaxOffset, workMethods, workStatuses } from "@/shared/api/domains/insights-common";

// Pure helpers of the classification console: ids, the category tree, the draft
// document and the small state machines of the review and reclassify tabs. The
// rules mirror internal/workintel/policy.go so the console explains a problem
// before the server has to reject it; the server stays the authority.

export const classificationTabIds = [
  "status",
  "categories",
  "policy",
  "test",
  "review",
  "reclassify",
  "baselines",
] as const;
export type ClassificationTabId = (typeof classificationTabIds)[number];

export const classificationTabLabels: Readonly<Record<ClassificationTabId, string>> = {
  status: "상태",
  categories: "카테고리",
  policy: "정책·버전",
  test: "테스트",
  review: "검토",
  reclassify: "재분류",
  baselines: "기준값",
};

/** Where the `WORK_INTEL_*` runtime settings are edited (the system settings screen). */
export const workIntelSettingsLink = {
  pathname: "/system/settings",
  search: "tab=runtime&q=WORK_INTEL",
} as const;

/** Query keys owned by one tab; they are dropped when another tab opens. */
export const tabScopedQueryKeys = [
  "status",
  "category",
  "max_conf",
  "page",
  "from",
  "to",
  "method",
  "version",
] as const;

// ---------------------------------------------------------------------------
// Category ids
// ---------------------------------------------------------------------------

export const otherCategoryId = "other";

/** The twelve top-level categories every policy keeps: they can be turned off, never removed. */
export const requiredTopLevelIds = [
  "dev",
  "infra",
  "itsm",
  "security",
  "data",
  "office",
  "planning",
  "support",
  "knowledge",
  "ai",
  "automation",
  otherCategoryId,
] as const;

export const maxCategoryDepth = 3;
export const maxCategories = 400;
export const categoryIdPattern = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*){0,2}$/u;
export const idSegmentPattern = /^[a-z0-9][a-z0-9_-]*$/u;
export const categoryIdHint =
  "영문 소문자·숫자로 시작하고 소문자·숫자·-·_ 만 씁니다. 단계는 점으로 구분하며 최대 3단계입니다.";

export const levelLabels: Readonly<Record<number, string>> = { 1: "대분류", 2: "중분류", 3: "소분류" };

export function levelOfId(id: string): number {
  return id.split(".").length;
}

/** The id one level up, or "" for a top-level id. */
export function parentOfId(id: string): string {
  const at = id.lastIndexOf(".");
  return at > 0 ? id.slice(0, at) : "";
}

export function topOfId(id: string): string {
  const at = id.indexOf(".");
  return at > 0 ? id.slice(0, at) : id;
}

export function isRequiredTopLevel(id: string): boolean {
  return (requiredTopLevelIds as readonly string[]).includes(id);
}

/** One id segment from a display name, or "" when the name has no Latin letters or digits. */
export function slugSegment(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 40)
    .replace(/[-_]+$/u, "");
}

/**
 * The id of a new category named `name` under `parentId` ("" for a top-level one):
 * the parent's id, a dot and a slug of the name, made unique among `taken`.
 */
export function childCategoryId(parentId: string, name: string, taken: ReadonlySet<string>): string {
  const segment = slugSegment(name) || "category";
  const root = parentId ? `${parentId}.${segment}` : segment;
  if (!taken.has(root)) return root;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${root}-${taken.size + 1}`;
}

/** Why `id` cannot be the id of a category under `parentId`, or undefined when it can. */
export function categoryIdProblem(
  id: string,
  parentId: string,
  taken: ReadonlySet<string>,
): string | undefined {
  if (id === "") return "ID를 입력하세요.";
  if (parentId) {
    if (!id.startsWith(`${parentId}.`)) return `하위 카테고리 ID는 '${parentId}.'로 시작해야 합니다.`;
    const segment = id.slice(parentId.length + 1);
    if (segment.includes(".")) return "한 단계 아래 ID만 쓸 수 있습니다. 점은 단계를 구분할 때만 씁니다.";
    if (!idSegmentPattern.test(segment)) return categoryIdHint;
  } else if (id.includes(".")) {
    return "대분류 ID에는 점을 쓸 수 없습니다.";
  }
  if (!categoryIdPattern.test(id)) return categoryIdHint;
  if (taken.has(id)) return "이미 있는 ID입니다.";
  return undefined;
}

// ---------------------------------------------------------------------------
// Category tree
// ---------------------------------------------------------------------------

export interface CategoryNode {
  category: WorkCategory;
  /** Position in `config.categories`, which is what server issue paths refer to. */
  index: number;
  level: number;
  children: CategoryNode[];
  /** Number of categories below this one, at any depth. */
  descendants: number;
}

/**
 * The categories as a forest in document order. A category whose parent is missing
 * is kept at the top so it stays reachable and can be fixed.
 */
export function buildCategoryTree(categories: readonly WorkCategory[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  categories.forEach((category, index) => {
    if (!nodes.has(category.id))
      nodes.set(category.id, {
        category,
        index,
        level: levelOfId(category.id),
        children: [],
        descendants: 0,
      });
  });
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.category.parent_id || parentOfId(node.category.id));
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const count = (node: CategoryNode): number => {
    node.descendants = node.children.reduce((sum, child) => sum + 1 + count(child), 0);
    return node.descendants;
  };
  roots.forEach(count);
  return roots;
}

export interface CategoryCounts {
  total: number;
  top: number;
  middle: number;
  leaf: number;
  disabled: number;
  merged: number;
}

export function categoryCounts(categories: readonly WorkCategory[]): CategoryCounts {
  const counts: CategoryCounts = {
    total: categories.length,
    top: 0,
    middle: 0,
    leaf: 0,
    disabled: 0,
    merged: 0,
  };
  for (const category of categories) {
    const level = levelOfId(category.id);
    if (level === 1) counts.top += 1;
    else if (level === 2) counts.middle += 1;
    else counts.leaf += 1;
    if (!category.enabled) counts.disabled += 1;
    if (category.merged_into) counts.merged += 1;
  }
  return counts;
}

/** Whether a category matches a search by name, id or one of its keywords. */
export function categoryMatches(category: WorkCategory, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [category.name, category.id, ...category.rules.keywords].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

/** The tree reduced to matching categories and the ancestors that lead to them. */
export function filterCategoryTree(nodes: readonly CategoryNode[], query: string): CategoryNode[] {
  if (!query.trim()) return [...nodes];
  const out: CategoryNode[] = [];
  for (const node of nodes) {
    const children = filterCategoryTree(node.children, query);
    if (children.length > 0 || categoryMatches(node.category, query)) out.push({ ...node, children });
  }
  return out;
}

export function countNodes(nodes: readonly CategoryNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

export interface CategoryOption {
  id: string;
  name: string;
  level: number;
  /** "소프트웨어 개발 › 코드 생성" */
  path: string;
  enabled: boolean;
  merged: boolean;
}

/** Every category in tree order with its readable path, for pickers and filters. */
export function categoryOptions(categories: readonly WorkCategory[]): CategoryOption[] {
  const out: CategoryOption[] = [];
  const walk = (nodes: readonly CategoryNode[], trail: readonly string[]): void => {
    for (const node of nodes) {
      const names = [...trail, node.category.name || node.category.id];
      out.push({
        id: node.category.id,
        name: node.category.name || node.category.id,
        level: node.level,
        path: names.join(" › "),
        enabled: node.category.enabled,
        merged: node.category.merged_into !== "",
      });
      walk(node.children, names);
    }
  };
  walk(buildCategoryTree(categories), []);
  return out;
}

/** Categories a request can be corrected to: in use and not folded into another one. */
export function assignableCategories(categories: readonly WorkCategory[], query = ""): CategoryOption[] {
  const needle = query.trim().toLowerCase();
  return categoryOptions(categories).filter(
    (option) =>
      option.enabled &&
      !option.merged &&
      (!needle || option.path.toLowerCase().includes(needle) || option.id.includes(needle)),
  );
}

/** Names from the top level down to `id`; unknown levels fall back to their id segment. */
export function categoryPath(categories: readonly WorkCategory[], id: string): string[] {
  if (!id) return [];
  const byId = new Map(categories.map((category) => [category.id, category]));
  const segments = id.split(".");
  return segments.map((segment, index) => {
    const partial = segments.slice(0, index + 1).join(".");
    return byId.get(partial)?.name || segment;
  });
}

export function categoryName(categories: readonly WorkCategory[], id: string): string {
  return categories.find((category) => category.id === id)?.name || id;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Categories `id` may be merged into: the same level, not itself, and not already
 * merged somewhere else (which keeps merges one step long and free of loops).
 */
export function mergeCandidates(categories: readonly WorkCategory[], id: string): WorkCategory[] {
  if (id === otherCategoryId) return [];
  const level = levelOfId(id);
  return categories.filter(
    (category) => category.id !== id && levelOfId(category.id) === level && category.merged_into === "",
  );
}

/** Categories folded into `id`. */
export function mergedSources(categories: readonly WorkCategory[], id: string): WorkCategory[] {
  return categories.filter((category) => category.merged_into === id);
}

/** The category statistics are shown under, following `merged_into`. */
export function canonicalCategoryId(categories: readonly WorkCategory[], id: string): string {
  const byId = new Map(categories.map((category) => [category.id, category]));
  let current = id;
  for (let step = 0; step <= categories.length; step += 1) {
    const next = byId.get(current)?.merged_into;
    if (!next || next === id) return current;
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Editing the draft
// ---------------------------------------------------------------------------

export function newCategory(id: string, parentId: string, name: string): WorkCategory {
  return {
    id,
    parent_id: parentId,
    name: name.trim(),
    description: "",
    examples: [],
    enabled: true,
    merged_into: "",
    rules: {
      keywords: [],
      mcp_servers: [],
      mcp_tools: [],
      languages: [],
      task_types: [],
      clients: [],
      weight: 1,
    },
  };
}

/** Adds a category right after its parent's last descendant, so siblings stay together. */
export function addCategory(config: WorkPolicyConfig, category: WorkCategory): WorkPolicyConfig {
  const categories = [...config.categories];
  let at = categories.length;
  if (category.parent_id) {
    const prefix = `${category.parent_id}.`;
    for (let index = categories.length - 1; index >= 0; index -= 1) {
      const id = categories[index]?.id ?? "";
      if (id === category.parent_id || id.startsWith(prefix)) {
        at = index + 1;
        break;
      }
    }
  }
  categories.splice(at, 0, category);
  return { ...config, categories };
}

export function updateCategory(
  config: WorkPolicyConfig,
  id: string,
  patch: Partial<Omit<WorkCategory, "id" | "parent_id" | "rules">> & { rules?: Partial<WorkRules> },
): WorkPolicyConfig {
  return {
    ...config,
    categories: config.categories.map((category) =>
      category.id === id
        ? { ...category, ...patch, rules: { ...category.rules, ...(patch.rules ?? {}) } }
        : category,
    ),
  };
}

/**
 * Renames a category that was never saved. Its children, the merges that point at
 * it and its baseline follow, so the document stays consistent.
 */
export function renameCategoryId(config: WorkPolicyConfig, oldId: string, newId: string): WorkPolicyConfig {
  if (oldId === newId) return config;
  const prefix = `${oldId}.`;
  const move = (id: string): string =>
    id === oldId ? newId : id.startsWith(prefix) ? `${newId}.${id.slice(prefix.length)}` : id;
  return {
    ...config,
    categories: config.categories.map((category) => ({
      ...category,
      id: move(category.id),
      parent_id: category.id === oldId ? parentOfId(newId) : move(category.parent_id),
      merged_into: move(category.merged_into),
    })),
    baselines: config.baselines.map((baseline) => ({ ...baseline, category_id: move(baseline.category_id) })),
  };
}

export interface RemovalImpact {
  /** Why the category cannot be removed, when it cannot. */
  blocked?: string;
  /** Whether the category exists in the saved draft (as opposed to added in this edit). */
  saved: boolean;
  descendants: number;
  /** Categories merged into the removed ones; their merge is undone. */
  unmerged: string[];
  /** Baselines that go with the removed categories. */
  baselines: number;
}

function subtreeIds(categories: readonly WorkCategory[], id: string): Set<string> {
  const prefix = `${id}.`;
  return new Set(categories.filter((c) => c.id === id || c.id.startsWith(prefix)).map((c) => c.id));
}

/** What removing `id` would do. Saved categories with children must lose the children first. */
export function removalImpact(
  config: WorkPolicyConfig,
  id: string,
  savedIds: ReadonlySet<string>,
): RemovalImpact {
  const ids = subtreeIds(config.categories, id);
  const saved = savedIds.has(id);
  const impact: RemovalImpact = {
    saved,
    descendants: ids.size - 1,
    unmerged: config.categories.filter((c) => !ids.has(c.id) && ids.has(c.merged_into)).map((c) => c.id),
    baselines: config.baselines.filter((baseline) => ids.has(baseline.category_id)).length,
  };
  if (isRequiredTopLevel(id)) {
    impact.blocked =
      id === otherCategoryId
        ? "'기타 및 미분류'는 분류되지 않은 요청이 모이는 곳이라 삭제하거나 끌 수 없습니다."
        : "기본 대분류는 삭제할 수 없습니다. 쓰지 않으려면 꺼 두세요.";
  } else if (saved && impact.descendants > 0) {
    impact.blocked = "하위 카테고리가 있습니다. 하위 카테고리를 먼저 삭제하거나 다른 카테고리로 병합하세요.";
  }
  return impact;
}

/** Removes a category with everything below it, the merges into it and its baselines. */
export function removeCategory(config: WorkPolicyConfig, id: string): WorkPolicyConfig {
  const ids = subtreeIds(config.categories, id);
  return {
    ...config,
    categories: config.categories
      .filter((category) => !ids.has(category.id))
      .map((category) => (ids.has(category.merged_into) ? { ...category, merged_into: "" } : category)),
    baselines: config.baselines.filter((baseline) => !ids.has(baseline.category_id)),
  };
}

/** Splits a comma or newline separated list, trimmed, without blanks or repeats. */
export function splitList(value: string, separators: "any" | "lines" = "any"): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(separators === "lines" ? /\n/u : /[\n,]/u)) {
    const item = raw.trim().replace(/\s+/gu, " ");
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function joinList(items: readonly string[], separators: "any" | "lines" = "any"): string {
  return items.join(separators === "lines" ? "\n" : ", ");
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Deterministic serialization for dirty checks: compare what will be saved, not
 * object identity or key order.
 */
export function configFingerprint(config: WorkPolicyConfig): string {
  return JSON.stringify(config, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return value;
  });
}

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------

export const thresholdLabels = {
  accept: "확정 기준",
  review_below: "검토 기준",
  min_evidence: "최소 근거 수",
  min_group_size: "최소 그룹 크기",
} as const;

export interface PolicyChanges {
  added: string[];
  removed: string[];
  renamed: string[];
  /** Categories whose merge target was set or redirected. */
  merged: string[];
  /** Categories whose matching changed: rules, the on/off switch, or an undone merge. */
  rulesChanged: string[];
  /** Categories whose description or examples changed (no effect on rule matching). */
  described: string[];
  actionTypes: boolean;
  thresholds: boolean;
  llm: boolean;
  baselines: number;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((item, index) => item === y[index]);
}

function rulesEqual(a: WorkRules, b: WorkRules): boolean {
  return (
    (a.weight || 1) === (b.weight || 1) &&
    sameSet(a.keywords, b.keywords) &&
    sameSet(a.mcp_servers, b.mcp_servers) &&
    sameSet(a.mcp_tools, b.mcp_tools) &&
    sameSet(a.languages, b.languages) &&
    sameSet(a.task_types, b.task_types) &&
    sameSet(a.clients, b.clients)
  );
}

/**
 * What differs between two policies. The category lists follow the server's own
 * version diff, so the summary before a save matches the change list of the
 * published version afterwards.
 */
export function diffPolicy(base: WorkPolicyConfig, draft: WorkPolicyConfig): PolicyChanges {
  const changes: PolicyChanges = {
    added: [],
    removed: [],
    renamed: [],
    merged: [],
    rulesChanged: [],
    described: [],
    actionTypes: JSON.stringify(base.action_types) !== JSON.stringify(draft.action_types),
    thresholds: JSON.stringify(base.thresholds) !== JSON.stringify(draft.thresholds),
    llm: JSON.stringify(base.llm) !== JSON.stringify(draft.llm),
    baselines: 0,
  };
  const before = new Map(base.categories.map((category) => [category.id, category]));
  const after = new Set<string>();
  for (const category of draft.categories) {
    if (after.has(category.id)) continue;
    after.add(category.id);
    const previous = before.get(category.id);
    if (!previous) {
      changes.added.push(category.id);
      continue;
    }
    if (previous.name !== category.name) changes.renamed.push(category.id);
    const mergeChanged = previous.merged_into !== category.merged_into;
    if (mergeChanged && category.merged_into !== "") changes.merged.push(category.id);
    if (
      !rulesEqual(previous.rules, category.rules) ||
      previous.enabled !== category.enabled ||
      (mergeChanged && category.merged_into === "")
    )
      changes.rulesChanged.push(category.id);
    if (previous.description !== category.description || !sameList(previous.examples, category.examples))
      changes.described.push(category.id);
  }
  for (const id of before.keys()) if (!after.has(id)) changes.removed.push(id);

  const baselineBefore = new Map(base.baselines.map((baseline) => [baseline.category_id, baseline]));
  const baselineAfter = new Map(draft.baselines.map((baseline) => [baseline.category_id, baseline]));
  for (const [id, baseline] of baselineAfter) {
    if (JSON.stringify(baselineBefore.get(id) ?? null) !== JSON.stringify(baseline)) changes.baselines += 1;
  }
  for (const id of baselineBefore.keys()) if (!baselineAfter.has(id)) changes.baselines += 1;
  for (const list of [changes.added, changes.removed, changes.renamed, changes.merged, changes.rulesChanged])
    list.sort();
  return changes;
}

/** The change in a few words, e.g. `카테고리 추가 2 · 규칙 변경 1 · 임계값 변경`. */
export function changeSummary(base: WorkPolicyConfig, draft: WorkPolicyConfig): string[] {
  const changes = diffPolicy(base, draft);
  const out: string[] = [];
  const counted = (label: string, n: number): void => {
    if (n > 0) out.push(`${label} ${n}`);
  };
  counted("카테고리 추가", changes.added.length);
  counted("카테고리 삭제", changes.removed.length);
  counted("이름 변경", changes.renamed.length);
  counted("병합", changes.merged.length);
  counted("규칙 변경", changes.rulesChanged.length);
  counted("설명·예시 변경", changes.described.length);
  if (changes.actionTypes) out.push("작업 유형 변경");
  if (changes.thresholds) out.push("임계값 변경");
  if (changes.llm) out.push("LLM 설정 변경");
  counted("기준값 변경", changes.baselines);
  return out;
}

/** The same change, one line per category, for a review before publishing. */
export function changeDetails(base: WorkPolicyConfig, draft: WorkPolicyConfig): string[] {
  const changes = diffPolicy(base, draft);
  const label = (config: WorkPolicyConfig, id: string): string => {
    const name = categoryName(config.categories, id);
    return name === id ? id : `${name} (${id})`;
  };
  const out: string[] = [];
  for (const id of changes.added) out.push(`추가: ${label(draft, id)}`);
  for (const id of changes.removed) out.push(`삭제: ${label(base, id)}`);
  for (const id of changes.renamed)
    out.push(
      `이름 변경: ${categoryName(base.categories, id)} → ${categoryName(draft.categories, id)} (${id})`,
    );
  for (const id of changes.merged) {
    const target = draft.categories.find((category) => category.id === id)?.merged_into ?? "";
    out.push(`병합: ${label(draft, id)} → ${label(draft, target)}`);
  }
  for (const id of changes.rulesChanged) out.push(`규칙 변경: ${label(draft, id)}`);
  for (const id of changes.described) out.push(`설명·예시 변경: ${label(draft, id)}`);
  if (changes.actionTypes) out.push("작업 유형 변경");
  if (changes.thresholds) {
    const fields: [keyof typeof thresholdLabels, string][] = [
      ["accept", thresholdLabels.accept],
      ["review_below", thresholdLabels.review_below],
      ["min_evidence", thresholdLabels.min_evidence],
      ["min_group_size", thresholdLabels.min_group_size],
    ];
    for (const [key, name] of fields) {
      if (base.thresholds[key] !== draft.thresholds[key])
        out.push(`임계값 ${name}: ${base.thresholds[key]} → ${draft.thresholds[key]}`);
    }
  }
  if (changes.llm) {
    if (base.llm.system_prompt !== draft.llm.system_prompt) out.push("LLM 시스템 프롬프트 변경");
    if (base.llm.max_input_chars !== draft.llm.max_input_chars)
      out.push(`LLM 입력 글자 수: ${base.llm.max_input_chars} → ${draft.llm.max_input_chars}`);
  }
  if (changes.baselines > 0) out.push(`기준값 변경 ${changes.baselines}건`);
  return out;
}

// ---------------------------------------------------------------------------
// Issues (422) and local checks
// ---------------------------------------------------------------------------

const categoryFieldLabels: Readonly<Record<string, string>> = {
  id: "ID",
  parent_id: "상위 카테고리",
  name: "이름",
  description: "설명",
  examples: "예시",
  enabled: "사용 여부",
  merged_into: "병합 대상",
  "rules.keywords": "키워드",
  "rules.mcp_servers": "MCP 서버",
  "rules.mcp_tools": "MCP 도구",
  "rules.languages": "언어",
  "rules.task_types": "코딩 작업 유형",
  "rules.clients": "클라이언트",
  "rules.weight": "가중치",
};

const baselineFieldLabels: Readonly<Record<string, string>> = {
  category_id: "카테고리",
  manual_minutes: "수동 처리 시간",
  ai_minutes: "AI 활용 처리 시간",
  hourly_cost_krw: "시간당 비용",
  note: "메모",
};

export type IssueTab = "categories" | "policy" | "baselines";

/** Which tab holds the field an issue path points at. */
export function issueTab(issue: WorkPolicyIssue): IssueTab {
  if (issue.path.startsWith("categories")) return "categories";
  if (issue.path.startsWith("baselines")) return "baselines";
  return "policy";
}

/** The category an issue is about, so the console can open it. */
export function issueCategoryId(issue: WorkPolicyIssue, config: WorkPolicyConfig): string | undefined {
  const match = /^categories\[(\d+)\]/u.exec(issue.path);
  return match ? config.categories[Number(match[1])]?.id : undefined;
}

/** `rules.keywords[7]` → `키워드 8번째`. */
function fieldLabel(labels: Readonly<Record<string, string>>, field: string): string {
  const item = /^(.*)\[(\d+)\]$/u.exec(field);
  const key = item?.[1] ?? field;
  const name = labels[key] ?? key;
  return item ? `${name} ${Number(item[2]) + 1}번째` : name;
}

/** A readable place for an issue path such as `categories[3].rules.keywords[7]`. */
export function issueLocation(issue: WorkPolicyIssue, config: WorkPolicyConfig): string {
  const category = /^categories\[(\d+)\](?:\.(.+))?$/u.exec(issue.path);
  if (category) {
    const item = config.categories[Number(category[1])];
    const label = `카테고리 ${item?.name || item?.id || Number(category[1]) + 1}`;
    return category[2] ? `${label} · ${fieldLabel(categoryFieldLabels, category[2])}` : label;
  }
  const action = /^action_types\[(\d+)\](?:\.(.+))?$/u.exec(issue.path);
  if (action) {
    const item = config.action_types[Number(action[1])];
    const label = `작업 유형 ${item?.name || item?.id || Number(action[1]) + 1}`;
    return action[2]
      ? `${label} · ${fieldLabel({ id: "ID", name: "이름", keywords: "키워드" }, action[2])}`
      : label;
  }
  const baseline = /^baselines\[(\d+)\](?:\.(.+))?$/u.exec(issue.path);
  if (baseline) {
    const item = config.baselines[Number(baseline[1])];
    const label = `기준값 ${item ? categoryName(config.categories, item.category_id) : Number(baseline[1]) + 1}`;
    return baseline[2] ? `${label} · ${fieldLabel(baselineFieldLabels, baseline[2])}` : label;
  }
  const threshold = /^thresholds\.(\w+)$/u.exec(issue.path);
  if (threshold) {
    const key = threshold[1] as keyof typeof thresholdLabels;
    return `임계값 · ${thresholdLabels[key] ?? threshold[1]}`;
  }
  const fields: Readonly<Record<string, string>> = {
    categories: "카테고리",
    action_types: "작업 유형",
    thresholds: "임계값",
    baselines: "기준값",
    "llm.system_prompt": "LLM · 시스템 프롬프트",
    "llm.max_input_chars": "LLM · 입력 글자 수",
  };
  return fields[issue.path] ?? issue.path;
}

/** Messages of the issues at `path` or inside it (`path.x`, `path[3]`). */
export function issuesAt(issues: readonly WorkPolicyIssue[], path: string): string[] {
  return issues
    .filter(
      (issue) =>
        issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`),
    )
    .map((issue) => issue.message);
}

/** The first issue at `path`, as a field error. */
export function issueAt(issues: readonly WorkPolicyIssue[], path: string): string | undefined {
  return issuesAt(issues, path)[0];
}

export function baselineProblems(
  baseline: Pick<WorkBaseline, "manual_minutes" | "ai_minutes" | "hourly_cost_krw">,
): Partial<Record<"manual_minutes" | "ai_minutes" | "hourly_cost_krw", string>> {
  const out: Partial<Record<"manual_minutes" | "ai_minutes" | "hourly_cost_krw", string>> = {};
  if (!(baseline.manual_minutes > 0)) out.manual_minutes = "수동 처리 시간(분)은 0보다 커야 합니다.";
  if (!(baseline.ai_minutes > 0)) out.ai_minutes = "AI 활용 처리 시간(분)은 0보다 커야 합니다.";
  if (!(baseline.hourly_cost_krw >= 0)) out.hourly_cost_krw = "시간당 비용은 0 이상이어야 합니다.";
  return out;
}

/** Estimated saving for one confirmed session under a baseline. */
export function baselineSaving(
  baseline: Pick<WorkBaseline, "manual_minutes" | "ai_minutes" | "hourly_cost_krw">,
): { minutes: number; costKrw: number } {
  const minutes = baseline.manual_minutes - baseline.ai_minutes;
  return { minutes, costKrw: (minutes / 60) * baseline.hourly_cost_krw };
}

/**
 * Problems the console can see without asking the server, in the server's own
 * path notation so both kinds are shown the same way. Not exhaustive: the save
 * still validates everything.
 */
export function localIssues(config: WorkPolicyConfig): WorkPolicyIssue[] {
  const issues: WorkPolicyIssue[] = [];
  const add = (path: string, message: string): void => {
    issues.push({ path, message });
  };
  if (config.categories.length > maxCategories)
    add("categories", `카테고리는 최대 ${maxCategories}개까지 등록할 수 있습니다.`);
  const ids = new Set(config.categories.map((category) => category.id));
  const seen = new Set<string>();
  config.categories.forEach((category, index) => {
    const path = `categories[${index}]`;
    if (category.id === "") add(`${path}.id`, "카테고리 ID가 비어 있습니다.");
    else if (!categoryIdPattern.test(category.id)) add(`${path}.id`, `카테고리 ID: ${categoryIdHint}`);
    else if (seen.has(category.id)) add(`${path}.id`, `카테고리 ID '${category.id}'가 중복되었습니다.`);
    else {
      const parent = parentOfId(category.id);
      if (parent && !ids.has(parent)) add(`${path}.parent_id`, `상위 카테고리 '${parent}'가 없습니다.`);
    }
    seen.add(category.id);
    if (category.name.trim() === "") add(`${path}.name`, "카테고리 이름이 비어 있습니다.");
    else if ([...category.name].length > 80) add(`${path}.name`, "카테고리 이름은 80자 이하여야 합니다.");
    if ([...category.description].length > 500) add(`${path}.description`, "설명은 500자 이하여야 합니다.");
    if (category.examples.length > 20) add(`${path}.examples`, "예시는 최대 20개까지 등록할 수 있습니다.");
    if (category.id === otherCategoryId && !category.enabled)
      add(`${path}.enabled`, "'other' 카테고리는 분류되지 않은 요청이 모이는 곳이라 끌 수 없습니다.");
    if (category.rules.keywords.length > 200)
      add(`${path}.rules.keywords`, "키워드는 카테고리마다 최대 200개까지 등록할 수 있습니다.");
    if (!(category.rules.weight > 0) || category.rules.weight > 10)
      add(`${path}.rules.weight`, "가중치는 0보다 크고 10 이하여야 합니다.");
  });

  const actions = new Set<string>();
  config.action_types.forEach((action, index) => {
    const path = `action_types[${index}]`;
    if (action.id === "") add(`${path}.id`, "작업 유형 ID가 비어 있습니다.");
    else if (!idSegmentPattern.test(action.id))
      add(`${path}.id`, "작업 유형 ID는 영문 소문자·숫자·-·_ 만 쓸 수 있습니다.");
    else if (action.id === "unknown")
      add(`${path}.id`, "'unknown'은 판단할 수 없을 때 쓰는 예약된 ID라 등록할 수 없습니다.");
    else if (actions.has(action.id)) add(`${path}.id`, `작업 유형 ID '${action.id}'가 중복되었습니다.`);
    actions.add(action.id);
    if (action.name.trim() === "") add(`${path}.name`, "작업 유형 이름이 비어 있습니다.");
  });

  const t = config.thresholds;
  if (!(t.accept >= 0 && t.accept <= 1)) add("thresholds.accept", "확정 기준은 0과 1 사이여야 합니다.");
  if (!(t.review_below >= 0 && t.review_below <= 1))
    add("thresholds.review_below", "검토 기준은 0과 1 사이여야 합니다.");
  if (t.accept < t.review_below)
    add("thresholds.accept", `확정 기준(${t.accept})은 검토 기준(${t.review_below})보다 낮을 수 없습니다.`);
  if (!Number.isInteger(t.min_evidence) || t.min_evidence < 1 || t.min_evidence > 10)
    add("thresholds.min_evidence", "최소 근거 수는 1 이상 10 이하의 정수여야 합니다.");
  if (!Number.isInteger(t.min_group_size) || t.min_group_size < 1 || t.min_group_size > 50)
    add("thresholds.min_group_size", "최소 그룹 크기는 1 이상 50 이하의 정수여야 합니다.");
  if (
    !Number.isInteger(config.llm.max_input_chars) ||
    config.llm.max_input_chars < 200 ||
    config.llm.max_input_chars > 8000
  )
    add("llm.max_input_chars", "분류 모델에 보내는 글자 수는 200 이상 8000 이하여야 합니다.");
  if (new TextEncoder().encode(config.llm.system_prompt).length > 8000)
    add("llm.system_prompt", "시스템 프롬프트는 8000바이트 이하여야 합니다.");

  config.baselines.forEach((baseline, index) => {
    const problems = baselineProblems(baseline);
    for (const [field, message] of Object.entries(problems)) add(`baselines[${index}].${field}`, message);
    if (!ids.has(baseline.category_id))
      add(`baselines[${index}].category_id`, `기준값의 카테고리 '${baseline.category_id}'가 없습니다.`);
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const statusLabels: Readonly<Record<string, string>> = {
  classified: "분류됨",
  review: "검토 필요",
  unclassified: "미분류",
  failed: "실패",
};

export const statusTones: Readonly<Record<string, "success" | "warning" | "muted" | "danger">> = {
  classified: "success",
  review: "warning",
  unclassified: "muted",
  failed: "danger",
};

export const methodLabels: Readonly<Record<string, string>> = {
  rule: "규칙",
  llm: "LLM",
  cache: "캐시",
  manual: "수동 보정",
};

/** The request path's coding task types, which a category rule may name. */
export const codingTaskTypes = [
  "debug",
  "test",
  "refactor",
  "translate",
  "docs",
  "review",
  "explain",
  "generate",
  "other",
] as const;

export function actionName(config: Pick<WorkPolicyConfig, "action_types">, id: string): string {
  if (!id || id === "unknown") return "알 수 없음";
  return config.action_types.find((action) => action.id === id)?.name || id;
}

export function formatConfidence(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}

/** `95` → `1분 35초`; the worker's lag behind the newest request. */
export function formatLag(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total}초`;
  if (total < 3600) return `${Math.floor(total / 60)}분 ${total % 60}초`;
  if (total < 86400) return `${Math.floor(total / 3600)}시간 ${Math.floor((total % 3600) / 60)}분`;
  return `${Math.floor(total / 86400)}일 ${Math.floor((total % 86400) / 3600)}시간`;
}

/** Method counts in a fixed order with their share; unknown methods go last. */
export function methodDistribution(
  byMethod: Readonly<Record<string, number>>,
): { method: string; label: string; count: number; share: number }[] {
  const known = workMethods as readonly string[];
  const keys = [...known, ...Object.keys(byMethod).filter((key) => !known.includes(key))];
  const total = keys.reduce((sum, key) => sum + (byMethod[key] ?? 0), 0);
  return keys.map((method) => {
    const count = byMethod[method] ?? 0;
    return { method, label: methodLabels[method] ?? method, count, share: total > 0 ? count / total : 0 };
  });
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

export const reviewPageSize = 50;
/** The last 1-based page the server answers: it refuses an offset above `workMaxOffset`. */
export const reviewLastPage = Math.floor(workMaxOffset / reviewPageSize) + 1;
export const maxCorrectionIds = 500;
export const confidenceCeilings = [0.3, 0.5, 0.6, 0.75, 0.9] as const;

export interface ReviewFilters {
  status?: WorkReviewStatus;
  category?: string;
  maxConf?: number;
  /** 1-based. */
  page: number;
}

export function reviewFiltersFromParams(params: URLSearchParams): ReviewFilters {
  const status = params.get("status") ?? "";
  const category = (params.get("category") ?? "").trim();
  const rawConf = params.get("max_conf");
  const maxConf = rawConf === null || rawConf.trim() === "" ? Number.NaN : Number(rawConf);
  const page = Number(params.get("page"));
  return {
    ...((workReviewStatuses as readonly string[]).includes(status)
      ? { status: status as WorkReviewStatus }
      : {}),
    ...(category && category.length <= 128 ? { category } : {}),
    ...(Number.isFinite(maxConf) && maxConf >= 0 && maxConf <= 1 ? { maxConf } : {}),
    page: Number.isInteger(page) && page > 0 && page <= reviewLastPage ? page : 1,
  };
}

export function reviewQuery(filters: ReviewFilters): WorkReviewQuery {
  return {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.maxConf !== undefined ? { max_conf: filters.maxConf } : {}),
    limit: reviewPageSize,
    offset: (filters.page - 1) * reviewPageSize,
  };
}

// ---------------------------------------------------------------------------
// Reclassify
// ---------------------------------------------------------------------------

export interface ReclassifyForm {
  from: string;
  to: string;
  status: string;
  category: string;
  method: string;
}

/** A real calendar date written as YYYY-MM-DD. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The Seoul calendar date of an instant, which is what the server's days mean. */
export function seoulDay(now: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** The last seven Seoul days, today included. */
export function defaultReclassifyPeriod(now: Date): { from: string; to: string } {
  const to = seoulDay(now);
  return { from: shiftDay(to, -6), to };
}

/** The reclassify form as the URL describes it; missing or malformed values take defaults. */
export function reclassifyFormFromParams(params: URLSearchParams, now: Date): ReclassifyForm {
  const period = defaultReclassifyPeriod(now);
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const status = params.get("status") ?? "";
  const method = params.get("method") ?? "";
  const category = (params.get("category") ?? "").trim();
  return {
    from: isDay(from) ? from : period.from,
    to: isDay(to) ? to : period.to,
    status: (workStatuses as readonly string[]).includes(status) ? status : "",
    category: category.length <= 128 ? category : "",
    method: (workMethods as readonly string[]).includes(method) ? method : "",
  };
}

export const maxReclassifyDays = 400;

export function reclassifyFormProblem(form: ReclassifyForm): string | undefined {
  if (!isDay(form.from) || !isDay(form.to)) return "기간의 시작일과 종료일을 YYYY-MM-DD 형식으로 입력하세요.";
  if (form.from > form.to) return "시작일이 종료일보다 늦습니다.";
  const days = (Date.parse(`${form.to}T00:00:00Z`) - Date.parse(`${form.from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > maxReclassifyDays) return `기간은 최대 ${maxReclassifyDays}일까지 고를 수 있습니다.`;
  return undefined;
}

export function reclassifyQuery(form: ReclassifyForm): WorkReclassifyQuery {
  return {
    from: form.from,
    to: form.to,
    ...(form.status ? { status: form.status } : {}),
    ...(form.category ? { category: form.category } : {}),
    ...(form.method ? { method: form.method } : {}),
  };
}

export type ReclassifyConflict = "expired" | "conflict" | "job_active";

/** The three ways a reviewed run is refused with 409. */
export function reclassifyConflictKind(code: string | undefined): ReclassifyConflict | undefined {
  if (code === "work_reclassify_expired") return "expired";
  if (code === "work_reclassify_conflict") return "conflict";
  if (code === "work_job_active") return "job_active";
  return undefined;
}

export const reclassifyConflictMessages: Readonly<Record<ReclassifyConflict, string>> = {
  expired: "미리보기가 만료되었습니다. 영향 미리보기를 다시 실행한 뒤 시작하세요.",
  conflict: "미리보기 이후 대상 요청이 바뀌었습니다. 영향 미리보기를 다시 실행한 뒤 시작하세요.",
  job_active: "이미 진행 중인 재분류 작업이 있습니다. 그 작업이 끝난 뒤 다시 시도하세요.",
};

export const jobStatusLabels: Readonly<Record<string, string>> = {
  queued: "대기 중",
  running: "진행 중",
  succeeded: "완료",
  failed: "실패",
  interrupted: "중단됨",
};

export const jobStatusTones: Readonly<Record<string, "info" | "success" | "danger" | "warning" | "muted">> = {
  queued: "muted",
  running: "info",
  succeeded: "success",
  failed: "danger",
  interrupted: "warning",
};

/** A job that will not change any more; polling stops here. */
export function jobFinished(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "interrupted";
}

export function daysRebuiltCount(value: number | readonly string[]): number {
  return typeof value === "number" ? value : value.length;
}

export function jobProgress(job: Pick<WorkJob, "status" | "progress">): { ratio: number; percent: number } {
  const { total, done } = job.progress;
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : job.status === "succeeded" ? 1 : 0;
  return { ratio, percent: Math.round(ratio * 100) };
}

/** react-query `refetchInterval` for a job: poll until it is finished. */
export function jobPollInterval(
  job: Pick<WorkJob, "status"> | undefined,
  milliseconds = 2_000,
): number | false {
  return job && jobFinished(job.status) ? false : milliseconds;
}

// ---------------------------------------------------------------------------
// Test samples
// ---------------------------------------------------------------------------

/** Synthetic prompts for the sample classifier: none of them come from real requests. */
export const classificationSamples: readonly {
  id: string;
  label: string;
  text: string;
  taskType?: string;
  languages?: string[];
  mcpTools?: string[];
  client?: string;
}[] = [
  {
    id: "codegen",
    label: "API 코드 작성",
    text: "주문 목록을 페이지 단위로 조회하는 REST API 핸들러를 Go로 작성해줘. 정렬과 필터 파라미터도 받아야 해.",
    taskType: "generate",
    languages: ["go"],
    client: "Claude Code",
  },
  {
    id: "incident",
    label: "장애 원인 분석",
    text: "어젯밤 결제 서비스 파드가 계속 재시작됐어. 쿠버네티스 이벤트와 로그를 보고 원인을 정리해줘.",
    mcpTools: ["kubectl_logs"],
  },
  {
    id: "report",
    label: "주간 보고서 초안",
    text: "이번 주 팀 업무 내용을 바탕으로 임원 보고용 주간 보고서 초안을 한 페이지로 만들어줘.",
  },
  {
    id: "sql",
    label: "매출 데이터 분석",
    text: "지난 분기 지역별 매출 추이를 구하는 SQL을 작성하고, 전년 동기 대비 증감률도 계산해줘.",
    languages: ["sql"],
  },
];

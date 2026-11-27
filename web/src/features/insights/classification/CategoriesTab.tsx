import { ChevronDown, ChevronRight, FolderPlus, Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { WorkCategory } from "@/shared/api/domains/insights-classification";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { Dialog } from "@/shared/components/ui/Dialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Switch } from "@/shared/components/ui/Switch";
import { Textarea } from "@/shared/components/ui/Textarea";

import type { PolicyEditorProps } from "./ClassificationPage";
import {
  addCategory,
  buildCategoryTree,
  categoryCounts,
  categoryIdHint,
  categoryIdProblem,
  categoryName,
  childCategoryId,
  codingTaskTypes,
  countNodes,
  filterCategoryTree,
  issueAt,
  issueCategoryId,
  levelLabels,
  levelOfId,
  maxCategoryDepth,
  mergeCandidates,
  mergedSources,
  newCategory,
  otherCategoryId,
  removalImpact,
  removeCategory,
  renameCategoryId,
  updateCategory,
  type CategoryNode,
} from "./classification-model";
import { ListField, NumberField } from "./fields";

interface CategoriesTabProps extends PolicyEditorProps {
  /** The category open in the editor ("" opens the first one). */
  selectedId: string;
  onSelect: (id: string) => void;
}

export function CategoriesTab({
  policy,
  draft,
  onChange,
  canWrite,
  writeReason,
  issues,
  selectedId,
  onSelect,
}: CategoriesTabProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<{ parentId: string } | null>(null);
  const addTopRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildCategoryTree(draft.categories), [draft.categories]);
  const visible = useMemo(() => filterCategoryTree(tree, query), [tree, query]);
  const counts = useMemo(() => categoryCounts(draft.categories), [draft.categories]);
  const savedIds = useMemo(
    () => new Set(policy.config.categories.map((category) => category.id)),
    [policy.config.categories],
  );
  const invalidIds = useMemo(() => {
    const ids = new Set<string>();
    for (const issue of issues) {
      const id = issueCategoryId(issue, draft);
      if (id) ids.add(id);
    }
    return ids;
  }, [issues, draft]);

  const selectedIndex = draft.categories.findIndex((category) => category.id === selectedId);
  const index = selectedIndex >= 0 ? selectedIndex : draft.categories.length > 0 ? 0 : -1;
  const selected = index >= 0 ? draft.categories[index] : undefined;
  const searching = query.trim() !== "";

  const select = (id: string): void => {
    onSelect(id);
    // On a narrow screen the editor sits below the tree: bring it into view.
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 960px)").matches) {
      window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: "start" }));
    }
  };
  const toggle = (id: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const isOpen = (id: string): boolean =>
    searching || expanded.has(id) || (selected !== undefined && selected.id.startsWith(`${id}.`));

  const renderNodes = (nodes: readonly CategoryNode[]): React.JSX.Element => (
    <ul className="wc-tree-list">
      {nodes.map((node) => {
        const { category } = node;
        const open = node.children.length > 0 && isOpen(category.id);
        const current = selected?.id === category.id;
        return (
          <li key={category.id}>
            <div
              className="wc-tree-row"
              data-selected={current || undefined}
              data-disabled={!category.enabled || undefined}
              data-invalid={invalidIds.has(category.id) || undefined}
            >
              {node.children.length > 0 ? (
                <button
                  type="button"
                  className="wc-tree-toggle"
                  aria-expanded={open}
                  aria-label={`${category.name || category.id} 하위 ${open ? "접기" : "펼치기"}`}
                  disabled={searching}
                  onClick={() => toggle(category.id)}
                >
                  {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                </button>
              ) : (
                <span className="wc-tree-toggle" aria-hidden="true" />
              )}
              <button
                type="button"
                className="wc-tree-item"
                aria-current={current ? "true" : undefined}
                onClick={() => select(category.id)}
              >
                <span className="wc-tree-name">{category.name || "(이름 없음)"}</span>
                <code className="wc-tree-id">{category.id}</code>
              </button>
              <span className="wc-tree-badges">
                {node.descendants > 0 ? (
                  <Badge title={`하위 카테고리 ${node.descendants}개`}>{node.descendants}</Badge>
                ) : null}
                {!savedIds.has(category.id) ? <Badge tone="info">저장 전</Badge> : null}
                {category.merged_into ? <Badge tone="warning">병합됨</Badge> : null}
                {!category.enabled ? <Badge>꺼짐</Badge> : null}
                {invalidIds.has(category.id) ? <Badge tone="danger">오류</Badge> : null}
              </span>
            </div>
            {open ? renderNodes(node.children) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <div className="wc-categories">
        <SectionCard
          headingLevel={3}
          title="카테고리 체계"
          description={`대분류 ${counts.top} · 중분류 ${counts.middle} · 소분류 ${counts.leaf} · 꺼짐 ${counts.disabled} · 병합 ${counts.merged}`}
          actions={
            <Button
              ref={addTopRef}
              size="small"
              disabled={!canWrite}
              title={canWrite ? undefined : writeReason}
              onClick={() => setAdding({ parentId: "" })}
            >
              <FolderPlus aria-hidden="true" /> 대분류 추가
            </Button>
          }
        >
          <div className="wc-tree-search">
            <Input
              type="search"
              aria-label="카테고리 찾기 (이름, ID, 키워드)"
              placeholder="이름, ID, 키워드로 찾기"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {searching ? (
              <span className="wc-muted" role="status">
                {countNodes(visible)}개 표시
              </span>
            ) : null}
          </div>
          {visible.length > 0 ? (
            <nav className="wc-tree" aria-label="카테고리 트리">
              {renderNodes(visible)}
            </nav>
          ) : (
            <EmptyState
              title={searching ? "조건에 맞는 카테고리가 없습니다." : "카테고리가 없습니다."}
              description={searching ? "다른 이름, ID, 키워드로 찾아 보세요." : undefined}
            />
          )}
        </SectionCard>

        <div ref={editorRef} className="wc-editor">
          {selected ? (
            <CategoryEditor
              key={selected.id}
              category={selected}
              index={index}
              draft={draft}
              onChange={onChange}
              canWrite={canWrite}
              writeReason={writeReason}
              issues={issues}
              saved={savedIds.has(selected.id)}
              savedIds={savedIds}
              onSelect={onSelect}
              onAddChild={() => setAdding({ parentId: selected.id })}
            />
          ) : (
            <SectionCard headingLevel={3} title="카테고리 편집">
              <EmptyState title="편집할 카테고리를 고르세요." />
            </SectionCard>
          )}
        </div>
      </div>

      {adding ? (
        <AddCategoryDialog
          parentId={adding.parentId}
          categories={draft.categories}
          returnFocusRef={addTopRef}
          onClose={() => setAdding(null)}
          onAdd={(category) => {
            onChange(addCategory(draft, category));
            setAdding(null);
            setQuery("");
            onSelect(category.id);
          }}
        />
      ) : null}
    </>
  );
}

interface CategoryEditorProps extends Omit<PolicyEditorProps, "policy"> {
  category: WorkCategory;
  index: number;
  saved: boolean;
  savedIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onAddChild: () => void;
}

function CategoryEditor({
  category,
  index,
  draft,
  onChange,
  canWrite,
  writeReason,
  issues,
  saved,
  savedIds,
  onSelect,
  onAddChild,
}: CategoryEditorProps): React.JSX.Element {
  const [idText, setIdText] = useState(category.id);
  const [removing, setRemoving] = useState(false);
  const removeRef = useRef<HTMLButtonElement>(null);
  const level = levelOfId(category.id);
  const path = `categories[${index}]`;
  const patch = (next: Parameters<typeof updateCategory>[2]): void =>
    onChange(updateCategory(draft, category.id, next));
  const error = (field: string): string | undefined => issueAt(issues, `${path}.${field}`);

  const taken = new Set(draft.categories.filter((c) => c.id !== category.id).map((c) => c.id));
  const idProblem = idText === category.id ? undefined : categoryIdProblem(idText, category.parent_id, taken);
  const candidates = mergeCandidates(draft.categories, category.id);
  const sources = mergedSources(draft.categories, category.id);
  const impact = removalImpact(draft, category.id, savedIds);
  const isOther = category.id === otherCategoryId;
  const lockTitle = canWrite ? undefined : writeReason;

  return (
    <SectionCard
      headingLevel={3}
      title={category.name || "(이름 없음)"}
      description={
        <span className="wc-editor-meta">
          <Badge tone="info">{levelLabels[level] ?? `${level}단계`}</Badge>
          <code>{category.id}</code>
          {saved ? null : <Badge tone="info">저장 전</Badge>}
          {category.merged_into ? <Badge tone="warning">병합됨</Badge> : null}
          {category.enabled ? null : <Badge>꺼짐</Badge>}
        </span>
      }
      actions={
        <>
          {level < maxCategoryDepth ? (
            <Button size="small" disabled={!canWrite} title={lockTitle} onClick={onAddChild}>
              <Plus aria-hidden="true" /> 하위 카테고리 추가
            </Button>
          ) : null}
          <Button
            ref={removeRef}
            size="small"
            variant="ghost"
            disabled={!canWrite || impact.blocked !== undefined}
            title={lockTitle ?? impact.blocked}
            onClick={() => setRemoving(true)}
          >
            <Trash2 aria-hidden="true" /> 삭제
          </Button>
        </>
      }
    >
      <fieldset className="wc-fieldset" disabled={!canWrite}>
        <legend className="sr-only">{category.name || category.id} 편집</legend>
        {impact.blocked && canWrite ? <p className="wc-muted wc-note">{impact.blocked}</p> : null}

        <div className="wc-form-grid">
          {saved ? (
            <FormField
              label="ID"
              description="저장된 카테고리의 ID는 바꿀 수 없습니다. 과거 통계와 분류 결과가 이 ID를 가리킵니다."
            >
              {(control) => <Input {...control} value={category.id} readOnly className="wc-mono" />}
            </FormField>
          ) : (
            <FormField
              label="ID"
              description={`처음 저장하기 전까지 바꿀 수 있습니다. ${categoryIdHint}`}
              error={idProblem ?? error("id") ?? error("parent_id")}
            >
              {(control) => (
                <span className="wc-inline-field">
                  <Input
                    {...control}
                    className="wc-mono"
                    value={idText}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setIdText(event.target.value.trim().toLowerCase())}
                  />
                  <Button
                    size="small"
                    disabled={idText === category.id || idProblem !== undefined}
                    onClick={() => {
                      onChange(renameCategoryId(draft, category.id, idText));
                      onSelect(idText);
                    }}
                  >
                    ID 적용
                  </Button>
                </span>
              )}
            </FormField>
          )}
          <FormField label="이름" required error={error("name")}>
            {(control) => (
              <Input
                {...control}
                value={category.name}
                maxLength={80}
                onChange={(event) => patch({ name: event.target.value })}
              />
            )}
          </FormField>
        </div>

        <FormField
          label="설명"
          description="분류 모델과 운영자가 이 카테고리를 구분할 때 읽는 설명입니다."
          error={error("description")}
        >
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              value={category.description}
              maxLength={500}
              onChange={(event) => patch({ description: event.target.value })}
            />
          )}
        </FormField>
        <ListField
          label="예시"
          description="이 카테고리에 속하는 요청의 예를 한 줄에 하나씩 적습니다(최대 20개). 실제 프롬프트나 개인정보는 넣지 마세요."
          separators="lines"
          rows={3}
          value={category.examples}
          error={error("examples")}
          onChange={(examples) => patch({ examples })}
        />

        <div className="wc-switch-row">
          <Switch
            checked={category.enabled}
            label={category.enabled ? "사용 중" : "꺼짐"}
            aria-label={`${category.name || category.id} 사용`}
            disabled={!canWrite || isOther}
            title={
              isOther ? "'기타 및 미분류'는 분류되지 않은 요청이 모이는 곳이라 끌 수 없습니다." : lockTitle
            }
            onCheckedChange={(enabled) => patch({ enabled })}
          />
          <span className="wc-muted">
            {isOther
              ? "분류되지 않은 요청이 모이는 카테고리라 항상 켜져 있습니다."
              : "끄면 새 요청은 이 카테고리로 분류되지 않습니다. 과거 통계는 그대로 남습니다."}
          </span>
        </div>
        {error("enabled") ? (
          <p className="field-error" role="alert">
            {error("enabled")}
          </p>
        ) : null}

        <h4 className="wc-subheading">분류 규칙</h4>
        <p className="wc-muted wc-note">
          규칙은 가린 프롬프트와 요청의 특징에서 근거를 찾아 점수를 냅니다. 키워드 하나만으로는 확정하지
          않으며, 근거가 정책의 최소 근거 수에 못 미치면 캐시·LLM·검토로 넘어갑니다.
        </p>
        <ListField
          label="키워드"
          description="프롬프트에 나오면 근거가 되는 말입니다. 쉼표나 줄바꿈으로 구분하며 대소문자는 구분하지 않습니다(최대 200개)."
          rows={3}
          value={category.rules.keywords}
          error={error("rules.keywords")}
          onChange={(keywords) => patch({ rules: { keywords } })}
        />
        <div className="wc-form-grid">
          <ListField
            label="MCP 서버"
            description="이 서버의 도구를 호출한 요청이면 근거가 됩니다."
            rows={1}
            value={category.rules.mcp_servers}
            error={error("rules.mcp_servers")}
            onChange={(mcp_servers) => patch({ rules: { mcp_servers } })}
          />
          <ListField
            label="MCP 도구"
            description="도구 이름입니다. 예: kubectl_logs, jira_search"
            rows={1}
            value={category.rules.mcp_tools}
            error={error("rules.mcp_tools")}
            onChange={(mcp_tools) => patch({ rules: { mcp_tools } })}
          />
          <ListField
            label="언어"
            description="요청에서 추론한 프로그래밍 언어입니다. 예: go, python, sql"
            rows={1}
            value={category.rules.languages}
            error={error("rules.languages")}
            onChange={(languages) => patch({ rules: { languages } })}
          />
          <ListField
            label="코딩 작업 유형"
            description={`요청 경로가 붙인 작업 유형입니다: ${codingTaskTypes.join(", ")}`}
            rows={1}
            value={category.rules.task_types}
            error={error("rules.task_types")}
            onChange={(task_types) => patch({ rules: { task_types } })}
          />
          <ListField
            label="클라이언트"
            description="예: Claude Code, Cursor, Cline"
            rows={1}
            value={category.rules.clients}
            error={error("rules.clients")}
            onChange={(clients) => patch({ rules: { clients } })}
          />
          <NumberField
            label="가중치"
            description="이 카테고리의 모든 근거에 곱합니다. 1이 기본이며 0보다 크고 10 이하입니다."
            min={0.1}
            max={10}
            step={0.1}
            value={category.rules.weight}
            error={error("rules.weight")}
            onChange={(weight) => patch({ rules: { weight } })}
          />
        </div>

        <h4 className="wc-subheading">다른 카테고리로 병합</h4>
        {isOther ? (
          <p className="wc-muted wc-note">'기타 및 미분류'는 다른 카테고리로 병합할 수 없습니다.</p>
        ) : (
          <>
            <FormField
              label="병합 대상"
              description={`같은 단계(${levelLabels[level] ?? ""})의 카테고리로만 병합할 수 있습니다.`}
              error={error("merged_into")}
            >
              {(control) => (
                <Select
                  {...control}
                  value={category.merged_into}
                  onChange={(event) => patch({ merged_into: event.target.value })}
                >
                  <option value="">병합하지 않음</option>
                  {category.merged_into && !candidates.some((c) => c.id === category.merged_into) ? (
                    <option value={category.merged_into}>
                      {categoryName(draft.categories, category.merged_into)} ({category.merged_into})
                    </option>
                  ) : null}
                  {candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name || candidate.id} ({candidate.id})
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            {category.merged_into ? (
              <InlineNotice tone="info" title="병합된 카테고리입니다.">
                배포하면 새 요청은 「{categoryName(draft.categories, category.merged_into)}」로 분류됩니다.
                과거 통계는 원래 ID(<code>{category.id}</code>)를 그대로 유지하며, 화면에서는 대상 카테고리
                아래에 합쳐서 보여 줍니다. 병합을 풀면 다시 따로 집계됩니다.
              </InlineNotice>
            ) : (
              <p className="wc-muted wc-note">
                병합해도 과거 통계의 ID는 바뀌지 않습니다. 조회할 때 대상 카테고리로 접어 합산합니다.
              </p>
            )}
          </>
        )}
        {sources.length > 0 ? (
          <p className="wc-note">
            이 카테고리로 병합된 카테고리:{" "}
            {sources.map((source) => `${source.name || source.id} (${source.id})`).join(", ")}
          </p>
        ) : null}
      </fieldset>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        returnFocusRef={removeRef}
        tone="danger"
        title="카테고리 삭제"
        confirmLabel="삭제"
        description={`「${category.name || category.id}」(${category.id}) 카테고리를 초안에서 삭제합니다.`}
        onConfirm={() => {
          const next = removeCategory(draft, category.id);
          onChange(next);
          onSelect(category.parent_id);
        }}
      >
        <ul className="wc-plain-list">
          {impact.saved ? (
            <li>
              저장·배포하면 새 요청은 이 카테고리로 분류되지 않습니다. 이미 분류된 과거 요청은 이 ID로 남아
              이름 없이 표시되고, 배포할 때 영향받는 요청 수를 알려 줍니다. 통계를 이어서 보려면 삭제 대신
              병합을 쓰세요.
            </li>
          ) : (
            <li>아직 저장하지 않은 카테고리라 통계에는 영향이 없습니다.</li>
          )}
          {impact.descendants > 0 ? <li>하위 카테고리 {impact.descendants}개도 함께 삭제합니다.</li> : null}
          {impact.unmerged.length > 0 ? (
            <li>이 카테고리로 병합된 {impact.unmerged.join(", ")}의 병합이 풀립니다.</li>
          ) : null}
          {impact.baselines > 0 ? <li>기준값 {impact.baselines}건도 함께 삭제합니다.</li> : null}
          <li>저장하기 전에는 「되돌리기」로 복구할 수 있습니다.</li>
        </ul>
      </ConfirmDialog>
    </SectionCard>
  );
}

function AddCategoryDialog({
  parentId,
  categories,
  returnFocusRef,
  onAdd,
  onClose,
}: {
  parentId: string;
  categories: readonly WorkCategory[];
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onAdd: (category: WorkCategory) => void;
  onClose: () => void;
}): React.JSX.Element {
  const taken = useMemo(() => new Set(categories.map((category) => category.id)), [categories]);
  const [name, setName] = useState("");
  // The id follows the name until the operator edits it by hand.
  const [customId, setCustomId] = useState<string | undefined>(undefined);
  const id = customId ?? (name.trim() ? childCategoryId(parentId, name, taken) : "");
  const idProblem = id === "" ? undefined : categoryIdProblem(id, parentId, taken);
  const level = parentId ? levelOfId(parentId) + 1 : 1;
  const parentName = parentId ? categoryName(categories, parentId) : "";
  const ready = name.trim() !== "" && id !== "" && idProblem === undefined;
  const submit = (): void => {
    if (ready) onAdd(newCategory(id, parentId, name));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title={parentId ? "하위 카테고리 추가" : "대분류 추가"}
      description={
        parentId
          ? `「${parentName}」 아래에 ${levelLabels[level] ?? "카테고리"}를 추가합니다. 초안에만 추가되며 저장·배포해야 분류에 쓰입니다.`
          : "새 대분류를 추가합니다. 초안에만 추가되며 저장·배포해야 분류에 쓰입니다."
      }
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" disabled={!ready} onClick={submit}>
            추가
          </Button>
        </>
      }
    >
      <form
        className="wc-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <FormField label="이름" required>
          {(control) => (
            <Input
              {...control}
              value={name}
              maxLength={80}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="ID"
          required
          description={`이름에서 만든 ID입니다. 처음 저장하기 전까지 바꿀 수 있고, 저장한 뒤에는 바꿀 수 없습니다. ${categoryIdHint}`}
          error={idProblem}
        >
          {(control) => (
            <Input
              {...control}
              className="wc-mono"
              value={id}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setCustomId(event.target.value.trim().toLowerCase())}
            />
          )}
        </FormField>
        {/* Enter in a field submits the form. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

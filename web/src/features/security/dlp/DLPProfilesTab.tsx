import { FlaskConical, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";

import type {
  DLPCatalogProfile,
  DLPConfidence,
  DLPCustomEntry,
  DLPCustomProfile,
  DLPProfileSettings,
} from "@/shared/api/domains/security-dlp";
import { dlpConfidences } from "@/shared/api/domains/security-dlp";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";

import type { DLPEditorProps } from "./DLPPage";
import {
  confidenceLabels,
  entryMatches,
  idHint,
  idPattern,
  newCustomProfile,
  policiesUsing,
  slugify,
  splitList,
  uniqueId,
} from "./dlp-model";

export function DLPProfilesTab({
  settings,
  draft,
  onChange,
  canWrite,
  issues,
  onTryText,
}: DLPEditorProps & {
  /** Opens the test scan with this text. */
  onTryText?: (text: string) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState<{ index: number; profile: DLPCustomProfile } | null>(null);
  const [search, setSearch] = useState("");
  const searching = search.trim() !== "";
  const visibleProfiles = settings.catalog
    .map((profile) => ({ profile, entries: profile.entries.filter((entry) => entryMatches(entry, search)) }))
    .filter(({ entries }) => !searching || entries.length > 0);
  const matchCount = visibleProfiles.reduce((sum, { entries }) => sum + entries.length, 0);
  const addRef = useRef<HTMLButtonElement>(null);
  const takenProfileIds = new Set([
    ...settings.catalog.map((profile) => profile.id),
    ...draft.custom_profiles.map((profile) => profile.id),
  ]);

  const updateBuiltin = (id: string, next: DLPProfileSettings): void => {
    const empty =
      next.disabled_entries.length === 0 && next.min_confidence === undefined && !next.min_matches;
    // Settings back at the defaults are dropped, so the stored document only says what differs.
    const profiles = Object.fromEntries(Object.entries(draft.profiles).filter(([key]) => key !== id));
    if (!empty) profiles[id] = next;
    onChange({ ...draft, profiles });
  };

  const removeCustom = (index: number): void => {
    const removed = draft.custom_profiles[index];
    if (!removed) return;
    // A policy that named the profile keeps working on its other profiles; one left
    // with none would not validate, so it goes too.
    const policies = draft.policies
      .map((policy) => ({ ...policy, profiles: policy.profiles.filter((id) => id !== removed.id) }))
      .filter((policy) => policy.profiles.length > 0);
    onChange({
      ...draft,
      custom_profiles: draft.custom_profiles.filter((_, i) => i !== index),
      policies,
    });
  };

  return (
    <>
      <InlineNotice tone="info" title="탐지 방식">
        형식만 보는 것이 아니라 검증합니다. 카드번호는 Luhn, 주민등록번호·사업자등록번호는 생년월일과 검증
        숫자, IBAN은 mod-97로 확인하고, 계좌번호처럼 형식만으로 구분하기 어려운 항목은 주변에
        &lsquo;계좌&rsquo; 같은 문맥 단어가 있을 때만 찾습니다. 문맥 단어가 근처에 있으면 신뢰도가 한 단계
        올라갑니다.
      </InlineNotice>

      <div className="dlp-entry-search" role="search">
        <FormField
          label="탐지 항목 찾기"
          description={
            searching
              ? `${visibleProfiles.length}개 프로필에서 ${matchCount}개 항목`
              : "이름·ID·설명·문맥 단어로 찾습니다. 예: 계좌, passport, jwt"
          }
        >
          {(control) => (
            <div className="dlp-search-field">
              <Search aria-hidden="true" />
              <Input
                {...control}
                type="search"
                value={search}
                placeholder="예: 주민, 카드, token"
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setSearch("");
                }}
              />
            </div>
          )}
        </FormField>
      </div>
      {searching && visibleProfiles.length === 0 ? (
        <EmptyState
          title="찾는 탐지 항목이 없습니다."
          description="다른 단어로 찾거나 사용자 정의 프로필로 직접 추가하세요."
        />
      ) : null}

      {visibleProfiles.map(({ profile, entries }) => (
        <BuiltinProfileCard
          key={profile.id}
          profile={profile}
          entries={entries}
          open={searching}
          onTryText={onTryText}
          value={draft.profiles[profile.id] ?? { disabled_entries: [] }}
          usedBy={policiesUsing(draft, profile.id).map((policy) => policy.name || policy.id)}
          canWrite={canWrite}
          problems={issues
            .filter((issue) => issue.path.startsWith(`profiles.${profile.id}`))
            .map((issue) => issue.message)}
          onChange={(next) => updateBuiltin(profile.id, next)}
        />
      ))}

      <SectionCard
        title="사용자 정의 프로필"
        description="사내 코드명, 프로젝트명, 사번 형식처럼 조직에만 있는 정보를 키워드나 정규식으로 정의합니다."
        actions={
          canWrite ? (
            <Button
              ref={addRef}
              variant="primary"
              onClick={() => setEditing({ index: -1, profile: newCustomProfile(takenProfileIds) })}
            >
              <Plus aria-hidden="true" /> 프로필 추가
            </Button>
          ) : undefined
        }
      >
        {draft.custom_profiles.length === 0 ? (
          <EmptyState
            title="사용자 정의 프로필이 없습니다."
            description="예: '프로젝트 오로라' 같은 내부 코드명 키워드, EMP-123456 같은 사번 정규식."
          />
        ) : (
          <ul className="dlp-policy-list" aria-label="사용자 정의 프로필 목록">
            {draft.custom_profiles.map((profile, index) => {
              const problems = issues
                .filter((issue) => issue.path.startsWith(`custom_profiles[${index}]`))
                .map((issue) => issue.message);
              const usedBy = policiesUsing(draft, profile.id);
              return (
                <li
                  key={`${profile.id}:${index}`}
                  className="dlp-policy"
                  data-enabled
                  data-invalid={problems.length > 0 || undefined}
                >
                  <div className="dlp-policy-head">
                    <div className="dlp-policy-title">
                      <strong>{profile.name || profile.id}</strong>
                      <code>{profile.id}</code>
                    </div>
                    <Badge tone="info">항목 {profile.entries.length}개</Badge>
                    {canWrite ? (
                      <div className="dlp-row-actions">
                        <Button
                          size="small"
                          variant="ghost"
                          aria-label={`${profile.name || profile.id} 편집`}
                          onClick={() => setEditing({ index, profile })}
                        >
                          <Pencil aria-hidden="true" /> 편집
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          aria-label={`${profile.name || profile.id} 삭제`}
                          onClick={() => removeCustom(index)}
                        >
                          <Trash2 aria-hidden="true" /> 삭제
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {profile.description ? <p className="dlp-muted">{profile.description}</p> : null}
                  <p className="dlp-muted">
                    {profile.entries.map((entry) => entry.name || entry.id).join(" · ")}
                    {" — "}
                    {usedBy.length > 0
                      ? `정책 ${usedBy.map((policy) => policy.name || policy.id).join(", ")}에서 사용`
                      : "아직 이 프로필을 쓰는 정책이 없습니다"}
                  </p>
                  {problems.length > 0 ? (
                    <ul className="dlp-inline-issues">
                      {problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {editing ? (
        <CustomProfileDialog
          key={`${editing.index}:${editing.profile.id}`}
          initial={editing.profile}
          isNew={editing.index < 0}
          takenIds={
            new Set(
              [...takenProfileIds].filter(
                (id) => editing.index < 0 || id !== draft.custom_profiles[editing.index]?.id,
              ),
            )
          }
          returnFocusRef={addRef}
          onClose={() => setEditing(null)}
          onApply={(profile) => {
            const custom = [...draft.custom_profiles];
            const previousId = editing.index >= 0 ? custom[editing.index]?.id : undefined;
            if (editing.index < 0) custom.push(profile);
            else custom[editing.index] = profile;
            // A renamed profile keeps its policies.
            const policies =
              previousId && previousId !== profile.id
                ? draft.policies.map((policy) => ({
                    ...policy,
                    profiles: policy.profiles.map((id) => (id === previousId ? profile.id : id)),
                  }))
                : draft.policies;
            onChange({ ...draft, custom_profiles: custom, policies });
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

function BuiltinProfileCard({
  profile,
  entries,
  open,
  onTryText,
  value,
  usedBy,
  canWrite,
  problems,
  onChange,
}: {
  profile: DLPCatalogProfile;
  entries: DLPCatalogProfile["entries"];
  open: boolean;
  onTryText?: (text: string) => void;
  value: DLPProfileSettings;
  usedBy: string[];
  canWrite: boolean;
  problems: string[];
  onChange: (next: DLPProfileSettings) => void;
}): React.JSX.Element {
  const disabled = new Set(value.disabled_entries);
  const record = profile.record_distinct > 0;
  const active =
    profile.entries.length - (record ? 0 : profile.entries.filter((entry) => disabled.has(entry.id)).length);
  return (
    <SectionCard
      title={profile.name}
      description={profile.description}
      actions={
        usedBy.length > 0 ? (
          <Badge tone="success">정책 {usedBy.length}개에서 사용</Badge>
        ) : (
          <Badge tone="muted">사용하는 정책 없음</Badge>
        )
      }
    >
      <div className="dlp-form-grid dlp-profile-settings">
        <FormField
          label="최소 신뢰도"
          description={`이보다 낮은 신뢰도의 일치는 무시합니다. 기본값: ${confidenceLabels[profile.default_min_confidence]}`}
        >
          {(control) => (
            <Select
              {...control}
              value={value.min_confidence ?? ""}
              disabled={!canWrite}
              onChange={(event) =>
                onChange({
                  ...value,
                  min_confidence: (event.target.value || undefined) as DLPConfidence | undefined,
                })
              }
            >
              <option value="">기본값 ({confidenceLabels[profile.default_min_confidence]})</option>
              {dlpConfidences.map((level) => (
                <option key={level} value={level}>
                  {confidenceLabels[level]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField
          label="최소 일치 수"
          description={
            record
              ? `서로 다른 항목 ${profile.record_distinct}종이 ${profile.record_window}바이트 안에 함께 있을 때 한 건으로 셉니다.`
              : `한 요청·응답에서 이만큼 찾았을 때만 프로필이 걸립니다. 기본값: ${profile.default_min_matches}`
          }
        >
          {(control) => (
            <Input
              {...control}
              type="number"
              min={1}
              max={100}
              inputMode="numeric"
              placeholder={String(profile.default_min_matches)}
              value={value.min_matches ? String(value.min_matches) : ""}
              disabled={!canWrite}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                onChange({
                  ...value,
                  min_matches: Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : undefined,
                });
              }}
            />
          )}
        </FormField>
        <p className="dlp-muted dlp-profile-count">
          {record
            ? `구성 항목 ${profile.entries.length}개`
            : `탐지 항목 ${active}/${profile.entries.length}개 사용`}
        </p>
      </div>
      {problems.length > 0 ? (
        <ul className="dlp-inline-issues">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      <details className="dlp-entries" open={open || undefined}>
        <summary>
          {record ? "구성 항목 보기" : "탐지 항목 보기·끄기"}
          {open ? ` (찾은 항목 ${entries.length}개)` : ""}
        </summary>
        <div className="data-table-scroll" tabIndex={0} aria-label={`${profile.name} 탐지 항목 표 영역`}>
          <table className="data-table dlp-entry-table">
            <caption className="sr-only">{profile.name} 탐지 항목</caption>
            <thead>
              <tr>
                {record ? null : <th scope="col">사용</th>}
                <th scope="col">항목</th>
                <th scope="col">신뢰도</th>
                <th scope="col">마스킹 표시</th>
                <th scope="col">가상 예시</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} data-disabled={(!record && disabled.has(entry.id)) || undefined}>
                  {record ? null : (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${entry.name} 탐지`}
                        checked={!disabled.has(entry.id)}
                        disabled={!canWrite}
                        onChange={(event) =>
                          onChange({
                            ...value,
                            disabled_entries: event.target.checked
                              ? value.disabled_entries.filter((id) => id !== entry.id)
                              : [...value.disabled_entries, entry.id],
                          })
                        }
                      />
                    </td>
                  )}
                  <th scope="row">
                    <span className="dlp-entry-name">{entry.name}</span>
                    {entry.description ? (
                      <span className="dlp-muted dlp-entry-desc">{entry.description}</span>
                    ) : null}
                    {entry.context.length > 0 ? (
                      <span className="dlp-muted dlp-entry-desc">
                        문맥: {entry.context.slice(0, 6).join(", ")}
                        {entry.context.length > 6 ? " …" : ""}
                      </span>
                    ) : null}
                  </th>
                  <td>
                    {entry.requires_context ? (
                      <Badge tone="warning">문맥 필요</Badge>
                    ) : (
                      confidenceLabels[entry.base_confidence]
                    )}
                  </td>
                  <td>
                    <code>{entry.mask}</code>
                  </td>
                  <td>
                    <span className="dlp-example-cell">
                      <code className="dlp-example">{entry.example}</code>
                      {onTryText && entry.example ? (
                        <Button
                          size="small"
                          variant="ghost"
                          aria-label={`${entry.name} 예시로 테스트 스캔 (${profile.name})`}
                          onClick={() => onTryText(entry.example)}
                        >
                          <FlaskConical aria-hidden="true" /> 시험
                        </Button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </SectionCard>
  );
}

function blankEntry(taken: ReadonlySet<string>): DLPCustomEntry {
  return {
    id: uniqueId("entry", taken, "entry"),
    name: "",
    type: "keywords",
    keywords: [],
    case_sensitive: false,
    confidence: "medium",
    context: [],
    mask: "",
  };
}

interface EntryDraft {
  id: string;
  idEdited: boolean;
  name: string;
  type: "regex" | "keywords";
  pattern: string;
  keywords: string;
  caseSensitive: boolean;
  confidence: DLPConfidence;
  context: string;
  mask: string;
}

function toEntryDraft(entry: DLPCustomEntry, isNew: boolean): EntryDraft {
  return {
    id: entry.id,
    idEdited: !isNew,
    name: entry.name,
    type: entry.type,
    pattern: entry.pattern ?? "",
    keywords: (entry.keywords ?? []).join("\n"),
    caseSensitive: entry.case_sensitive ?? false,
    confidence: entry.confidence ?? "medium",
    context: (entry.context ?? []).join(", "),
    mask: entry.mask ?? "",
  };
}

function entryId(entry: EntryDraft, index: number): string {
  return entry.idEdited ? entry.id.trim() : slugify(entry.name) || entry.id || `entry-${index + 1}`;
}

function entryProblem(entry: EntryDraft, id: string, duplicate: boolean): string | undefined {
  if (!idPattern.test(id)) return `항목 ID: ${idHint}`;
  if (duplicate) return "항목 ID가 중복됩니다.";
  if (entry.name.trim() === "") return "항목 이름을 입력하세요.";
  if (entry.type === "regex") {
    if (entry.pattern.trim() === "") return "정규식을 입력하세요.";
    if (entry.pattern.length > 512) return "정규식은 512자까지입니다.";
  } else if (splitList(entry.keywords).length === 0) {
    return "키워드를 하나 이상 입력하세요.";
  }
  return undefined;
}

function CustomProfileDialog({
  initial,
  isNew,
  takenIds,
  returnFocusRef,
  onClose,
  onApply,
}: {
  initial: DLPCustomProfile;
  isNew: boolean;
  takenIds: ReadonlySet<string>;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onApply: (profile: DLPCustomProfile) => void;
}): React.JSX.Element {
  const groupId = useId();
  const [name, setName] = useState(initial.name);
  const [id, setId] = useState(initial.id);
  const [idEdited, setIdEdited] = useState(!isNew);
  const [description, setDescription] = useState(initial.description ?? "");
  const [minConfidence, setMinConfidence] = useState<DLPConfidence>(initial.min_confidence ?? "low");
  const [minMatches, setMinMatches] = useState(
    initial.min_matches && initial.min_matches > 0 ? initial.min_matches : 1,
  );
  const [entries, setEntries] = useState<EntryDraft[]>(
    initial.entries.map((entry) => toEntryDraft(entry, isNew)),
  );
  const [touched, setTouched] = useState(false);

  const effectiveId = idEdited ? id.trim() : uniqueId(slugify(name), takenIds, initial.id);
  const idError = !idPattern.test(effectiveId)
    ? idHint
    : takenIds.has(effectiveId)
      ? "같은 ID의 프로필이 이미 있습니다."
      : undefined;
  const nameError = name.trim() === "" ? "프로필 이름을 입력하세요." : undefined;
  const ids = entries.map((entry, index) => entryId(entry, index));
  const entryProblems = entries.map((entry, index) =>
    entryProblem(entry, ids[index] ?? "", ids.indexOf(ids[index] ?? "") !== index),
  );
  const entriesError = entries.length === 0 ? "탐지 항목을 하나 이상 두세요." : undefined;
  const ready = !idError && !nameError && !entriesError && entryProblems.every((problem) => !problem);

  const patch = (index: number, next: Partial<EntryDraft>): void =>
    setEntries((current) => current.map((entry, i) => (i === index ? { ...entry, ...next } : entry)));

  const apply = (): void => {
    setTouched(true);
    if (!ready) return;
    onApply({
      id: effectiveId,
      name: name.trim(),
      description: description.trim(),
      min_confidence: minConfidence,
      min_matches: minMatches,
      entries: entries.map((entry, index) => ({
        id: ids[index] ?? entry.id,
        name: entry.name.trim(),
        type: entry.type,
        ...(entry.type === "regex"
          ? { pattern: entry.pattern.trim() }
          : { keywords: splitList(entry.keywords) }),
        case_sensitive: entry.caseSensitive,
        confidence: entry.confidence,
        context: splitList(entry.context),
        mask: entry.mask.trim(),
      })),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title={isNew ? "사용자 정의 프로필 추가" : "사용자 정의 프로필 편집"}
      description="정규식 문법 오류는 저장할 때 서버가 알려 줍니다. 테스트 스캔 탭에서 저장 전 초안으로 먼저 확인할 수 있습니다."
      wide
      scrollBody
      scrollBodyLabel="사용자 정의 프로필 입력 영역"
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" disabled={touched && !ready} onClick={apply}>
            {isNew ? "추가" : "적용"}
          </Button>
        </>
      }
    >
      <div className="dlp-dialog">
        <div className="dlp-form-grid">
          <FormField
            label="이름"
            required
            error={touched ? nameError : undefined}
            description="예: 내부 프로젝트 코드명"
          >
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </FormField>
          <FormField label="ID" required error={touched ? idError : undefined} description={idHint}>
            {(control) => (
              <Input
                {...control}
                value={effectiveId}
                maxLength={63}
                spellCheck={false}
                onChange={(event) => {
                  setIdEdited(true);
                  setId(event.target.value.toLowerCase());
                }}
              />
            )}
          </FormField>
        </div>
        <FormField label="설명">
          {(control) => (
            <Input
              {...control}
              value={description}
              maxLength={300}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </FormField>
        <div className="dlp-form-grid">
          <FormField label="최소 신뢰도" description="항목의 신뢰도가 이보다 낮으면 무시합니다.">
            {(control) => (
              <Select
                {...control}
                value={minConfidence}
                onChange={(event) => setMinConfidence(event.target.value as DLPConfidence)}
              >
                {dlpConfidences.map((level) => (
                  <option key={level} value={level}>
                    {confidenceLabels[level]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="최소 일치 수" description="한 요청·응답에서 이만큼 찾았을 때 프로필이 걸립니다.">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                max={100}
                value={String(minMatches)}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  setMinMatches(Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 100)) : 1);
                }}
              />
            )}
          </FormField>
        </div>

        <fieldset className="dlp-fieldset">
          <legend>탐지 항목</legend>
          {touched && entriesError ? <p className="field-error">{entriesError}</p> : null}
          <ol className="dlp-entry-editor">
            {entries.map((entry, index) => {
              const problem = touched ? entryProblems[index] : undefined;
              return (
                <li key={index} data-invalid={problem ? true : undefined}>
                  <div className="dlp-form-grid">
                    <FormField label="항목 이름" required>
                      {(control) => (
                        <Input
                          {...control}
                          value={entry.name}
                          maxLength={120}
                          onChange={(event) => patch(index, { name: event.target.value })}
                        />
                      )}
                    </FormField>
                    <FormField
                      label="항목 ID"
                      description={`이벤트에는 ${effectiveId}/${ids[index] ?? ""} 로 남습니다.`}
                    >
                      {(control) => (
                        <Input
                          {...control}
                          value={ids[index] ?? ""}
                          maxLength={63}
                          spellCheck={false}
                          onChange={(event) =>
                            patch(index, { id: event.target.value.toLowerCase(), idEdited: true })
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="방식">
                      {(control) => (
                        <Select
                          {...control}
                          value={entry.type}
                          onChange={(event) =>
                            patch(index, { type: event.target.value === "regex" ? "regex" : "keywords" })
                          }
                        >
                          <option value="keywords">키워드 목록</option>
                          <option value="regex">정규식 (RE2)</option>
                        </Select>
                      )}
                    </FormField>
                    <FormField label="신뢰도">
                      {(control) => (
                        <Select
                          {...control}
                          value={entry.confidence}
                          onChange={(event) =>
                            patch(index, { confidence: event.target.value as DLPConfidence })
                          }
                        >
                          {dlpConfidences.map((level) => (
                            <option key={level} value={level}>
                              {confidenceLabels[level]}
                            </option>
                          ))}
                        </Select>
                      )}
                    </FormField>
                  </div>
                  {entry.type === "regex" ? (
                    <FormField
                      label="정규식"
                      description="Go RE2 문법입니다. 단어 경계가 필요하면 \b 를 쓰세요. 예: \bEMP-\d{6}\b"
                    >
                      {(control) => (
                        <Input
                          {...control}
                          value={entry.pattern}
                          maxLength={512}
                          spellCheck={false}
                          className="dlp-mono"
                          onChange={(event) => patch(index, { pattern: event.target.value })}
                        />
                      )}
                    </FormField>
                  ) : (
                    <FormField
                      label="키워드"
                      description="한 줄에 하나씩, 또는 쉼표로 구분합니다. 문장 속 어디에 있어도 글자 그대로 찾습니다(부분 일치)."
                    >
                      {(control) => (
                        <Textarea
                          {...control}
                          rows={3}
                          value={entry.keywords}
                          onChange={(event) => patch(index, { keywords: event.target.value })}
                        />
                      )}
                    </FormField>
                  )}
                  <div className="dlp-form-grid">
                    <FormField
                      label="문맥 단어"
                      description="근처에 있으면 신뢰도가 한 단계 오릅니다. 쉼표로 구분."
                    >
                      {(control) => (
                        <Input
                          {...control}
                          value={entry.context}
                          onChange={(event) => patch(index, { context: event.target.value })}
                        />
                      )}
                    </FormField>
                    <FormField
                      label="마스킹 표시"
                      description={`비우면 [REDACTED_${(ids[index] ?? "ENTRY").toUpperCase().replace(/-/gu, "_")}]`}
                    >
                      {(control) => (
                        <Input
                          {...control}
                          value={entry.mask}
                          maxLength={60}
                          onChange={(event) => patch(index, { mask: event.target.value })}
                        />
                      )}
                    </FormField>
                  </div>
                  <div className="dlp-entry-footer">
                    <Checkbox
                      label="대소문자 구분"
                      checked={entry.caseSensitive}
                      onChange={(event) => patch(index, { caseSensitive: event.target.checked })}
                    />
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={entries.length <= 1}
                      aria-label={`${entry.name || `항목 ${index + 1}`} 삭제`}
                      onClick={() => setEntries((current) => current.filter((_, i) => i !== index))}
                    >
                      <Trash2 aria-hidden="true" /> 항목 삭제
                    </Button>
                  </div>
                  {problem ? (
                    <p className="field-error" id={`${groupId}-entry-${index}`}>
                      {problem}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <Button
            size="small"
            disabled={entries.length >= 50}
            onClick={() =>
              setEntries((current) => [...current, toEntryDraft(blankEntry(new Set(ids)), true)])
            }
          >
            <Plus aria-hidden="true" /> 항목 추가
          </Button>
        </fieldset>
      </div>
    </Dialog>
  );
}

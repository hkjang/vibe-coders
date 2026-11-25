import { Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";

import type { DLPAction, DLPCheck, DLPPolicy } from "@/shared/api/domains/security-dlp";
import { dlpActions, dlpChecks } from "@/shared/api/domains/security-dlp";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Switch } from "@/shared/components/ui/Switch";
import { Textarea } from "@/shared/components/ui/Textarea";

import type { DLPEditorProps } from "./DLPPage";
import {
  actionDescriptions,
  actionLabels,
  actionTones,
  checkLabels,
  idHint,
  idPattern,
  newPolicy,
  profileName,
  profileOptions,
  slugify,
  splitList,
  uniqueId,
  withRecommended,
  type ProfileOption,
} from "./dlp-model";

export function DLPPoliciesTab({
  settings,
  draft,
  onChange,
  canWrite,
  writeReason,
  issues,
}: DLPEditorProps): React.JSX.Element {
  const [editing, setEditing] = useState<{ index: number; policy: DLPPolicy } | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const options = profileOptions(settings.catalog, draft);
  const missingRecommended = settings.recommended_policies.filter(
    (policy) => !draft.policies.some((existing) => existing.id === policy.id),
  );
  const issuesFor = (index: number): string[] =>
    issues.filter((issue) => issue.path.startsWith(`policies[${index}]`)).map((issue) => issue.message);

  const replace = (index: number, policy: DLPPolicy): void => {
    const policies = [...draft.policies];
    if (index < 0) policies.push(policy);
    else policies[index] = policy;
    onChange({ ...draft, policies });
  };

  return (
    <>
      <SectionCard
        title="정책"
        description="정책은 고른 프로필에서 무언가를 찾았을 때의 동작입니다. 여러 정책이 걸리면 가장 강한 동작(차단 > 마스킹 > 기록)을 적용하고, 걸린 정책은 모두 기록합니다."
        actions={
          canWrite ? (
            <>
              {missingRecommended.length > 0 ? (
                <Button onClick={() => onChange(withRecommended(draft, settings.recommended_policies))}>
                  <Sparkles aria-hidden="true" /> 권장 정책 {missingRecommended.length}개 추가
                </Button>
              ) : null}
              <Button
                ref={addRef}
                variant="primary"
                onClick={() =>
                  setEditing({ index: -1, policy: newPolicy(new Set(draft.policies.map((p) => p.id))) })
                }
              >
                <Plus aria-hidden="true" /> 정책 추가
              </Button>
            </>
          ) : undefined
        }
      >
        {draft.policies.length === 0 ? (
          <EmptyState
            title="정책이 없습니다."
            description="DLP는 정책이 가리키는 프로필만 검사합니다. 새 정책은 먼저 '기록'으로 두고 탐지 이벤트에서 오탐을 확인한 뒤 마스킹이나 차단으로 올리세요."
          />
        ) : (
          <ul className="dlp-policy-list" aria-label="DLP 정책 목록">
            {draft.policies.map((policy, index) => {
              const problems = issuesFor(index);
              return (
                <li
                  key={`${policy.id}:${index}`}
                  className="dlp-policy"
                  data-enabled={policy.enabled || undefined}
                  data-invalid={problems.length > 0 || undefined}
                >
                  <div className="dlp-policy-head">
                    <Switch
                      checked={policy.enabled}
                      label={policy.enabled ? "켜짐" : "꺼짐"}
                      aria-label={`${policy.name || policy.id} ${policy.enabled ? "끄기" : "켜기"}`}
                      disabled={!canWrite}
                      title={canWrite ? undefined : writeReason}
                      onCheckedChange={(enabled) => replace(index, { ...policy, enabled })}
                    />
                    <div className="dlp-policy-title">
                      <strong>{policy.name || policy.id}</strong>
                      <code>{policy.id}</code>
                    </div>
                    <Badge tone={actionTones[policy.action]}>{actionLabels[policy.action]}</Badge>
                    {canWrite ? (
                      <div className="dlp-row-actions">
                        <Button
                          size="small"
                          variant="ghost"
                          aria-label={`${policy.name || policy.id} 편집`}
                          onClick={() => setEditing({ index, policy })}
                        >
                          <Pencil aria-hidden="true" /> 편집
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          aria-label={`${policy.name || policy.id} 삭제`}
                          onClick={() =>
                            onChange({ ...draft, policies: draft.policies.filter((_, i) => i !== index) })
                          }
                        >
                          <Trash2 aria-hidden="true" /> 삭제
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <dl className="dlp-policy-facts">
                    <div>
                      <dt>검사 대상</dt>
                      <dd>{policy.check.map((check) => checkLabels[check]).join(" · ") || "없음"}</dd>
                    </div>
                    <div>
                      <dt>프로필</dt>
                      <dd className="dlp-chips">
                        {policy.profiles.map((id) => (
                          <span key={id} className="dlp-chip">
                            {profileName(id, settings.catalog, draft)}
                          </span>
                        ))}
                      </dd>
                    </div>
                    <div>
                      <dt>적용 범위</dt>
                      <dd>{scopeLabel(policy)}</dd>
                    </div>
                  </dl>
                  {policy.note ? <p className="dlp-muted dlp-policy-note">{policy.note}</p> : null}
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
        <PolicyDialog
          key={`${editing.index}:${editing.policy.id}`}
          initial={editing.policy}
          isNew={editing.index < 0}
          takenIds={new Set(draft.policies.filter((_, i) => i !== editing.index).map((p) => p.id))}
          options={options}
          returnFocusRef={addRef}
          onClose={() => setEditing(null)}
          onApply={(policy) => {
            replace(editing.index, policy);
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

function scopeLabel(policy: DLPPolicy): string {
  const teams = policy.teams ?? [];
  const keys = policy.api_keys ?? [];
  if (teams.length === 0 && keys.length === 0) return "모든 팀·키";
  const parts: string[] = [];
  if (teams.length > 0) parts.push(`팀 ${teams.join(", ")}`);
  if (keys.length > 0) parts.push(`키 ${keys.join(", ")}`);
  return parts.join(" 그리고 ");
}

function PolicyDialog({
  initial,
  isNew,
  takenIds,
  options,
  returnFocusRef,
  onClose,
  onApply,
}: {
  initial: DLPPolicy;
  isNew: boolean;
  takenIds: ReadonlySet<string>;
  options: readonly ProfileOption[];
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onApply: (policy: DLPPolicy) => void;
}): React.JSX.Element {
  const groupId = useId();
  const [name, setName] = useState(initial.name ?? "");
  const [id, setId] = useState(initial.id);
  const [idEdited, setIdEdited] = useState(!isNew);
  const [action, setAction] = useState<DLPAction>(initial.action);
  const [checks, setChecks] = useState<DLPCheck[]>(initial.check);
  const [profiles, setProfiles] = useState<string[]>(initial.profiles);
  const [teams, setTeams] = useState((initial.teams ?? []).join(", "));
  const [keys, setKeys] = useState((initial.api_keys ?? []).join(", "));
  const [note, setNote] = useState(initial.note ?? "");
  const [touched, setTouched] = useState(false);

  const effectiveId = idEdited ? id.trim() : uniqueId(slugify(name), takenIds, initial.id);
  const idError = !idPattern.test(effectiveId)
    ? idHint
    : takenIds.has(effectiveId)
      ? "같은 ID의 정책이 이미 있습니다."
      : undefined;
  const profileError = profiles.length === 0 ? "프로필을 하나 이상 고르세요." : undefined;
  const checkError = checks.length === 0 ? "요청이나 응답 중 하나 이상을 고르세요." : undefined;
  const ready = !idError && !profileError && !checkError;

  const toggle = <T,>(list: T[], value: T, on: boolean): T[] =>
    on ? [...list.filter((item) => item !== value), value] : list.filter((item) => item !== value);

  const apply = (): void => {
    setTouched(true);
    if (!ready) return;
    onApply({
      ...initial,
      id: effectiveId,
      name: name.trim(),
      action,
      check: dlpChecks.filter((check) => checks.includes(check)),
      profiles: options.map((option) => option.id).filter((option) => profiles.includes(option)),
      teams: splitList(teams),
      api_keys: splitList(keys),
      note: note.trim(),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title={isNew ? "정책 추가" : "정책 편집"}
      description="바꾼 내용은 화면 아래 저장 버튼을 눌러야 게이트웨이에 적용됩니다."
      wide
      scrollBody
      scrollBodyLabel="DLP 정책 입력 영역"
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
          <FormField label="이름" description="예: 고객 개인정보 마스킹">
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

        <fieldset className="dlp-fieldset">
          <legend>동작</legend>
          <div className="dlp-choice-grid">
            {dlpActions.map((value) => (
              <label
                key={value}
                className="dlp-choice"
                data-tone={actionTones[value]}
                data-selected={action === value || undefined}
              >
                <input
                  type="radio"
                  name={`${groupId}-action`}
                  value={value}
                  checked={action === value}
                  onChange={() => setAction(value)}
                />
                <span>
                  <strong>{actionLabels[value]}</strong> <code>{value}</code>
                  <small>{actionDescriptions[value]}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset
          className="dlp-fieldset"
          aria-describedby={touched && checkError ? `${groupId}-check-error` : undefined}
        >
          <legend>검사 대상</legend>
          <div className="dlp-inline-choices">
            <Checkbox
              label="요청 (프롬프트)"
              description="모델에 보내기 전에 검사합니다."
              checked={checks.includes("REQUEST")}
              onChange={(event) => setChecks(toggle(checks, "REQUEST", event.target.checked))}
            />
            <Checkbox
              label="응답 (모델 답변)"
              description="스트리밍 응답은 끝까지 받은 뒤 검사합니다."
              checked={checks.includes("RESPONSE")}
              onChange={(event) => setChecks(toggle(checks, "RESPONSE", event.target.checked))}
            />
          </div>
          {touched && checkError ? (
            <p className="field-error" id={`${groupId}-check-error`}>
              {checkError}
            </p>
          ) : null}
        </fieldset>

        <fieldset
          className="dlp-fieldset"
          aria-describedby={touched && profileError ? `${groupId}-profile-error` : undefined}
        >
          <legend>프로필</legend>
          <div className="dlp-profile-choices">
            {options.map((option) => (
              <Checkbox
                key={option.id}
                label={option.name}
                description={option.custom ? `사용자 정의 · ${option.id}` : option.id}
                checked={profiles.includes(option.id)}
                onChange={(event) => setProfiles(toggle(profiles, option.id, event.target.checked))}
              />
            ))}
          </div>
          {touched && profileError ? (
            <p className="field-error" id={`${groupId}-profile-error`}>
              {profileError}
            </p>
          ) : null}
        </fieldset>

        <div className="dlp-form-grid">
          <FormField label="적용할 팀" description="쉼표로 구분합니다. 비워 두면 모든 팀에 적용합니다.">
            {(control) => (
              <Input
                {...control}
                value={teams}
                spellCheck={false}
                onChange={(event) => setTeams(event.target.value)}
              />
            )}
          </FormField>
          <FormField
            label="적용할 API 키 ID"
            description="쉼표로 구분합니다. 팀과 함께 지정하면 팀과 키가 모두 맞을 때만 적용합니다."
          >
            {(control) => (
              <Input
                {...control}
                value={keys}
                spellCheck={false}
                onChange={(event) => setKeys(event.target.value)}
              />
            )}
          </FormField>
        </div>
        <FormField
          label="메모"
          description="왜 이 정책이 필요한지 남겨 두면 다음 운영자가 판단하기 쉽습니다."
        >
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </FormField>
      </div>
    </Dialog>
  );
}

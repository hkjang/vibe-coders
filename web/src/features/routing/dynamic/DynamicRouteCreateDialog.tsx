import { useId, useState, type RefObject } from "react";

import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";

import { applyTemplateModels, parseGraphText, routeNamePattern, routeTemplates } from "./dynamic-route-model";
import {
  dynamicRouteErrorMessage,
  rejectionValidation,
  type useDynamicRouteWrites,
} from "./use-dynamic-routes";

interface CreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  writes: ReturnType<typeof useDynamicRouteWrites>;
  onCreated: (id: string) => void;
}

/** Name the route and pick where it starts: a template with its models filled in, or pasted JSON. */
export function DynamicRouteCreateDialog({
  open,
  onOpenChange,
  returnFocusRef,
  writes,
  onCreated,
}: CreateDialogProps): React.JSX.Element {
  const groupId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<"template" | "json">("template");
  const [templateId, setTemplateId] = useState(routeTemplates[0]?.id ?? "single");
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [deploy, setDeploy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverIssues, setServerIssues] = useState<string[]>([]);

  const normalizedName = name.trim().toLowerCase();
  const nameError =
    normalizedName === ""
      ? "경로 이름을 입력하세요."
      : routeNamePattern.test(normalizedName)
        ? undefined
        : "영문 소문자·숫자로 시작하고 영문 소문자·숫자·. _ - 만 쓸 수 있습니다.";
  const template = routeTemplates.find((item) => item.id === templateId);
  const parsed = source === "json" ? parseGraphText(jsonText) : undefined;
  const modelError = source === "template" && primary.trim() === "" ? "기본 모델을 입력하세요." : undefined;
  const graph =
    source === "template" && template
      ? applyTemplateModels(template.graph, primary.trim(), secondary.trim())
      : parsed?.graph;
  const ready =
    nameError === undefined && graph !== undefined && modelError === undefined && writes.access.allowed;

  const reset = (): void => {
    setName("");
    setDescription("");
    setPrimary("");
    setSecondary("");
    setJsonText("");
    setDeploy(false);
    setTouched(false);
    setServerIssues([]);
  };

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (!ready || !graph) return;
    setServerIssues([]);
    try {
      const result = await writes.create.mutateAsync({
        name: normalizedName,
        description: description.trim(),
        graph,
        note: source === "json" ? "JSON에서 가져옴" : `템플릿: ${template?.title ?? ""}`,
        deploy,
      });
      reset();
      onOpenChange(false);
      onCreated(result.route.id);
    } catch (error) {
      const validation = rejectionValidation(error);
      setServerIssues(
        validation
          ? validation.errors.map((issue) =>
              issue.element_id ? `${issue.element_id}: ${issue.message}` : issue.message,
            )
          : [dynamicRouteErrorMessage(error)],
      );
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      returnFocusRef={returnFocusRef}
      title="새 동적 경로"
      description="이름은 호출 모델 dynamic/<이름>이 됩니다. 만든 직후에는 배포되지 않으며, 편집기에서 다듬은 뒤 배포할 수 있습니다."
      wide
      scrollBody
      scrollBodyLabel="새 동적 경로 입력 영역"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>취소</Button>
          <Button
            variant="primary"
            disabled={writes.create.isPending || (touched && !ready)}
            onClick={() => void submit()}
          >
            {writes.create.isPending ? "만드는 중…" : deploy ? "만들고 바로 배포" : "만들기"}
          </Button>
        </>
      }
    >
      <div className="dr-create">
        <FormField
          label="경로 이름"
          required
          error={touched ? nameError : undefined}
          description={
            normalizedName && !nameError
              ? `호출 모델: dynamic/${normalizedName}`
              : "예: support, chat-premium"
          }
        >
          {(control) => (
            <Input
              {...control}
              value={name}
              maxLength={63}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="설명">
          {(control) => (
            <Input
              {...control}
              value={description}
              maxLength={200}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </FormField>

        <fieldset className="dr-create-source">
          <legend>시작 방식</legend>
          <label>
            <input
              type="radio"
              name={`${groupId}-source`}
              checked={source === "template"}
              onChange={() => setSource("template")}
            />{" "}
            템플릿에서 시작
          </label>
          <label>
            <input
              type="radio"
              name={`${groupId}-source`}
              checked={source === "json"}
              onChange={() => setSource("json")}
            />{" "}
            JSON 붙여넣기 (Cloudflare 내보내기 호환)
          </label>
        </fieldset>

        {source === "template" ? (
          <>
            <fieldset className="dr-template-grid">
              <legend className="sr-only">템플릿</legend>
              {routeTemplates.map((item) => (
                <label
                  key={item.id}
                  className={item.id === templateId ? "dr-template dr-template-selected" : "dr-template"}
                >
                  <input
                    type="radio"
                    name={`${groupId}-template`}
                    checked={item.id === templateId}
                    onChange={() => setTemplateId(item.id)}
                  />
                  <span className="dr-template-title">{item.title}</span>
                  <span className="dr-template-desc">{item.description}</span>
                </label>
              ))}
            </fieldset>
            <div className="dr-form-grid">
              <FormField
                label="기본 모델"
                required
                error={touched ? modelError : undefined}
                description="템플릿의 첫 모델 요소에 들어갑니다."
              >
                {(control) => (
                  <Input
                    {...control}
                    value={primary}
                    placeholder="gpt-4.1"
                    onChange={(event) => setPrimary(event.target.value)}
                  />
                )}
              </FormField>
              <FormField
                label="보조 모델"
                description="폴백·경량·후보 모델에 들어갑니다. 비우면 기본 모델을 씁니다."
              >
                {(control) => (
                  <Input
                    {...control}
                    value={secondary}
                    placeholder="gpt-4.1-mini"
                    onChange={(event) => setSecondary(event.target.value)}
                  />
                )}
              </FormField>
            </div>
          </>
        ) : (
          <FormField
            label="경로 JSON"
            error={touched || jsonText ? parsed?.error : undefined}
            description='{"elements": [...]} 형식입니다. 캔버스 위치 같은 쓰지 않는 필드는 저장할 때 빠집니다.'
          >
            {(control) => (
              <Textarea
                {...control}
                className="dr-code"
                rows={12}
                spellCheck={false}
                value={jsonText}
                onChange={(event) => setJsonText(event.target.value)}
              />
            )}
          </FormField>
        )}

        <Checkbox
          checked={deploy}
          onChange={(event) => setDeploy(event.target.checked)}
          label="만든 직후 버전 1을 배포합니다"
          description="배포하면 곧바로 트래픽을 받습니다. 처음에는 배포하지 않고 시뮬레이션으로 확인하는 것을 권합니다."
        />

        {serverIssues.length > 0 ? (
          <InlineNotice tone="danger" title="경로를 만들지 못했습니다.">
            <ul className="dr-plain-list">
              {serverIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </InlineNotice>
        ) : null}
      </div>
    </Dialog>
  );
}

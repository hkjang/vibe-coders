package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/workintel"
)

// The semantic classification step of work intelligence: one call to the
// classification model per request the rules could not settle. It is only
// ever made by the background worker (and by the policy test screen), never
// on the request path, and it does not go through the proxy pipeline: a
// classification call logged as a request would itself be classified.

const (
	// workIntelLLMMaxResponseBytes bounds what is read of a model response.
	// The answer is one small JSON object.
	workIntelLLMMaxResponseBytes = 256 << 10

	workIntelLLMBlockedModel    = "llm_model_not_set"
	workIntelLLMBlockedProvider = "llm_provider_unavailable"
	workIntelLLMBlockedExternal = "llm_external_provider_not_allowed"
	workIntelLLMBlockedPaused   = "llm_paused_after_failures"
	workIntelLLMBlockedBudget   = "llm_budget_exhausted"
)

// workIntelLLMClient is the client of every call to the classification model
// (classification and the insight rewrite). It is the shared client without
// redirects: the provider was checked to be internal before the call, and a
// 307 or 308 would send the same body, which holds request text, to whatever
// host the answer names. A redirect is answered as the failure it is.
func (s *Server) workIntelLLMClient() *http.Client {
	bounded := *s.client
	bounded.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &bounded
}

// workIntelLLMTarget is the provider and model the semantic step will call.
type workIntelLLMTarget struct {
	provider resolvedProvider
	model    string
	host     string
	internal bool
}

// workIntelLLMBlock says why the semantic step may not run. Code is stable
// for programs; Reason is the sentence shown to an administrator.
type workIntelLLMBlock struct {
	Code   string
	Reason string
}

// workIntelLLMCall is the outcome of one classification call.
type workIntelLLMCall struct {
	Result           workintel.Result
	PromptTokens     int
	CompletionTokens int
	CostKRW          float64
}

// workIntelProviderInternal reports whether a provider address stays inside
// the organisation's network, judged from the address alone: a loopback,
// private or link-local IP, or a name that only resolves internally (no dot,
// or one of the internal-only suffixes). Anything else is treated as external,
// including a name that cannot be read.
func workIntelProviderInternal(baseURL string) (internal bool, host string) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return false, ""
	}
	host = strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if host == "" {
		return false, ""
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		addr = addr.Unmap()
		return addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast(), host
	}
	if host == "localhost" || !strings.Contains(host, ".") {
		return true, host
	}
	for _, suffix := range []string{".internal", ".local", ".svc", ".cluster.local", ".localhost"} {
		if strings.HasSuffix(host, suffix) {
			return true, host
		}
	}
	return false, host
}

// workIntelLLMTargetFor resolves the provider of the classification model and
// decides whether classification text may be sent to it. A non-nil block
// means the step must not run; nothing has been sent.
func (s *Server) workIntelLLMTargetFor(ctx context.Context, conf workIntelConfig) (workIntelLLMTarget, *workIntelLLMBlock) {
	model := strings.TrimSpace(conf.LLMModel)
	if model == "" {
		return workIntelLLMTarget{}, &workIntelLLMBlock{Code: workIntelLLMBlockedModel,
			Reason: "분류 모델(work_intel.llm_model)이 지정되지 않아 LLM 분류를 하지 않았습니다."}
	}
	// Provider selection reads the request it is given; a background caller has
	// none, so it hands over an empty one.
	synthetic := httptest.NewRequest(http.MethodPost, "/admin/work-intel/classify", nil).WithContext(ctx)
	provider, err := s.selectProviderForced(ctx, synthetic, model, strings.TrimSpace(conf.LLMProvider))
	if err != nil {
		return workIntelLLMTarget{}, &workIntelLLMBlock{Code: workIntelLLMBlockedProvider,
			Reason: "분류 모델을 호출할 Provider를 쓸 수 없어 LLM 분류를 하지 않았습니다: " + boundedWorkIntelError(err)}
	}
	internal, host := workIntelProviderInternal(provider.BaseURL)
	target := workIntelLLMTarget{provider: provider, model: model, host: host, internal: internal}
	if !internal && !conf.LLMAllowExternal {
		return target, &workIntelLLMBlock{Code: workIntelLLMBlockedExternal,
			Reason: fmt.Sprintf("분류 모델 Provider '%s'의 주소(%s)가 내부망이 아니어서 분류 텍스트를 보내지 않았습니다. 외부 전송을 허용하려면 work_intel.llm_allow_external 을 켜세요.",
				boundedModelsProviderLabelOrEmpty(provider.Name), host)}
	}
	return target, nil
}

// workIntelLLMClassify asks the classification model about one request and
// validates the answer against the policy. The text in f must already be
// redacted. The returned result has method "llm"; its title, tags and hint
// were written by a model that read the prompt and still have to be redacted
// (redactWorkIntelResult) before they are stored.
func (s *Server) workIntelLLMClassify(ctx context.Context, engine *workintel.Engine, target workIntelLLMTarget, f workintel.Features, timeout time.Duration) (workIntelLLMCall, error) {
	var call workIntelLLMCall
	if timeout <= 0 {
		timeout = defaultWorkIntelConfig().LLMTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	system, user := workintel.BuildLLMMessages(engine, f)
	// Only the fields every OpenAI-compatible provider accepts: sampling and
	// output-limit parameters differ between model families, and a rejected
	// parameter would fail every call.
	body, err := json.Marshal(map[string]any{
		"model":  target.model,
		"stream": false,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
	})
	if err != nil {
		return call, errors.New(governanceRunErrRequestEncoding)
	}
	upstreamURL, err := s.upstreamURL(target.provider.BaseURL, &url.URL{Path: "/v1/chat/completions"})
	if err != nil {
		return call, errors.New(governanceRunErrUpstreamURL)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		return call, errors.New(governanceRunErrRequestBuild)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+target.provider.APIKey)
	req.Header.Set("X-Request-ID", newID("trace"))

	resp, err := s.workIntelLLMClient().Do(req)
	if err != nil {
		// The transport error can quote the provider URL; only its kind is kept.
		if ctx.Err() != nil || fallbackReasonForError(err) == "timeout" {
			return call, errors.New(governanceRunErrTimeout)
		}
		return call, errors.New(governanceRunErrTransport)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, workIntelLLMMaxResponseBytes))
	if err != nil {
		if ctx.Err() != nil {
			return call, errors.New(governanceRunErrTimeout)
		}
		return call, errors.New(governanceRunErrResponseRead)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Provider error bodies are untrusted and may echo the request.
		return call, fmt.Errorf("%s (%d)", governanceRunErrStatus, resp.StatusCode)
	}

	content := extractChatContent(raw)
	var usage struct {
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	_ = json.Unmarshal(raw, &usage)
	call.PromptTokens, call.CompletionTokens = usage.Usage.PromptTokens, usage.Usage.CompletionTokens
	if call.PromptTokens == 0 && call.CompletionTokens == 0 {
		call.PromptTokens = audit.EstimateTokens(system) + audit.EstimateTokens(user)
		call.CompletionTokens = audit.EstimateTokens(content)
	}
	call.CostKRW = audit.EstimateCostKRW(target.model, audit.Usage{
		PromptTokens: call.PromptTokens, CompletionTokens: call.CompletionTokens,
		TotalTokens: call.PromptTokens + call.CompletionTokens,
	}, s.pricingMap(ctx))

	// The call was made and paid for even when its answer is unusable, so the
	// usage is returned with the error.
	result, err := workintel.ParseLLMResponse(engine, content)
	if err != nil {
		return call, fmt.Errorf("invalid_classification_response: %w", err)
	}
	call.Result = result
	return call, nil
}

// redactWorkIntelResult re-redacts everything in a result that a model wrote
// after reading the prompt: the secret patterns always, and the DLP profiles
// of the enabled policies when DLP is on. A model can copy an account number
// from the prompt into a title; the title is stored and shown to people who
// may not see prompts.
func (s *Server) redactWorkIntelResult(ctx context.Context, res workintel.Result) workintel.Result {
	redact := s.workIntelRedactor(ctx)
	res.WorkTitle = redact(res.WorkTitle)
	res.NewCategoryHint = redact(res.NewCategoryHint)
	res.TargetSystem = redact(res.TargetSystem)
	res.Tags = workIntelRedactList(res.Tags, redact)
	res.Technologies = workIntelRedactList(res.Technologies, redact)
	return res
}

func workIntelRedactList(items []string, redact func(string) string) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item = strings.TrimSpace(redact(item)); item != "" {
			out = append(out, item)
		}
	}
	return out
}

// workIntelRedactor returns the redaction applied to model-written labels.
func (s *Server) workIntelRedactor(ctx context.Context) func(string) string {
	engine := s.dlpEngine(ctx)
	profiles := []string{}
	if engine.Enabled() {
		seen := map[string]bool{}
		for _, policy := range engine.Config().Policies {
			if !policy.Enabled {
				continue
			}
			for _, id := range policy.Profiles {
				if !seen[id] {
					seen[id] = true
					profiles = append(profiles, id)
				}
			}
		}
	}
	return func(text string) (out string) {
		if text == "" {
			return text
		}
		out = audit.Redact(text)
		if len(profiles) == 0 {
			return out
		}
		// A label that cannot be checked is not stored.
		defer func() {
			if p := recover(); p != nil {
				slog.Error("work intel: dlp redaction of a classification label failed; dropping the label", "panic", p)
				out = ""
			}
		}()
		return engine.Redact(out, profiles)
	}
}

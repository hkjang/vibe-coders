package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

const providerHealthWindow = 15 * time.Minute

var fileMentionRe = regexp.MustCompile(`(?i)\b[\w./\\-]+\.(go|ts|tsx|js|jsx|py|java|kt|rs|rb|php|cs|cpp|c|h|sql|yaml|yml|json|toml|md)\b`)

type intelligentRoutingPlan struct {
	// Prompts is what this plan was scored from. It is carried so the audit record can
	// reuse it instead of extracting and redacting the same body a second time -- the
	// two calls sit a few lines apart in stepRouting and redaction is the expensive half
	// of extraction. Only valid when RawPrompts was off; see auditRequestWithPrompts.
	Prompts []store.PromptLog

	RequestedModel   string
	SelectedModel    string
	SelectedProvider string
	Complexity       store.ComplexityAnalysis
	Risk             store.RiskAnalysis
	HealthScore      int
	// FallbackPlan is what *would* happen on failure, computed before the call.
	// FallbackPath is what *actually* happened, appended as real hops occur — it
	// stays empty when no failover took place. Keeping the two apart matters: they
	// used to share one slice, so every request rendered a "fallback chain" in the
	// admin UI even when nothing had failed over.
	FallbackPlan   []string
	FallbackPath   []string
	DecisionReason string
	RouteReason    string
	ForceProvider  bool
}

func (s *Server) planIntelligentRouting(ctx context.Context, body []byte, endpoint string, pinned, noRoute bool, authCtx *store.AuthContext) intelligentRoutingPlan {
	model, _, prompts, _ := extractAudit(body, endpoint, false)
	toolCount := 0
	if root := jsonMap(body); root != nil {
		toolCount = countRequestTools(root)
	}
	complexity := analyzeComplexity(prompts, toolCount)
	risk := analyzeRisk(prompts)
	selectedModel := model
	forcedProvider := ""
	forceProvider := false
	routeReason := "client_model"
	reasons := []string{"client requested " + firstNonEmpty(model, "(empty)")}

	auto := isAutoModelAlias(model)
	tier := elevatedTierForRisk(complexity.Tier, risk.Score)
	if tier != complexity.Tier {
		reasons = append(reasons, "risk escalated tier "+complexity.Tier+" -> "+tier)
	}

	if noRoute {
		reasons = append(reasons, "routing disabled by X-Proxy-No-Route")
	} else if auto {
		selectedModel = s.defaultAutoModelForPolicy(tier, authCtx)
		routeReason = "auto_router"
		forceProvider = !pinned
		reasons = append(reasons, "auto alias mapped "+tier+" tier to "+selectedModel)
		// Closed learning loop: prefer the model that historically performed best
		// for this (task type, complexity bucket), when the loop is enabled and the
		// learned choice is allowed by the key's policy.
		if learned, why, ok := s.learnedModelFor(ctx, classifyTaskType(prompts), complexity.Score); ok && learned != selectedModel {
			if authCtx == nil || listAllows(learned, authCtx.AllowedModels, authCtx.DeniedModels) {
				selectedModel = learned
				routeReason = "auto_router_learned"
				reasons = append(reasons, why)
			}
		}
		if pinned {
			reasons = append(reasons, "provider pinned by client")
		}
	} else if pinned {
		reasons = append(reasons, "provider pinned by client")
	} else if d := s.evaluateRoutingRules(ctx, model, complexity.Score); d.Applied {
		selectedModel = d.TargetModel
		forcedProvider = d.TargetProvider
		forceProvider = forcedProvider != ""
		routeReason = d.Reason
		reasons = append(reasons, d.Desc)
	}
	if authCtx != nil && auto && selectedModel != "" && !listAllows(selectedModel, authCtx.AllowedModels, authCtx.DeniedModels) {
		if replacement := s.defaultAutoModelForPolicy(tier, authCtx); replacement != "" && replacement != selectedModel {
			reasons = append(reasons, "model policy replaced "+selectedModel+" -> "+replacement)
			selectedModel = replacement
		}
	}

	selectedProvider, health := "", 100
	if forcedProvider != "" {
		selectedProvider = forcedProvider
		health = s.healthScoreForProvider(ctx, selectedProvider)
	} else if !pinned {
		if auto {
			selectedProvider, health = s.bestProviderForRoutingModels(ctx, []string{selectedModel, model}, authCtx)
		} else {
			selectedProvider, health = s.bestProviderForRouting(ctx, selectedModel, authCtx)
		}
	}
	if selectedProvider != "" {
		reasons = append(reasons, "provider health selected "+selectedProvider+"("+itoaProxy(health)+")")
	}
	if selectedModel == "" {
		selectedModel = model
	}
	fallbackPlan := s.routingFallbackPlan(ctx, selectedModel, selectedProvider)
	if riskDisablesFallback(risk) {
		fallbackPlan = []string{"fallback_disabled:sensitive_data"}
		reasons = append(reasons, "safe fallback disabled for sensitive data risk")
	}

	return intelligentRoutingPlan{
		Prompts:          prompts,
		RequestedModel:   model,
		SelectedModel:    selectedModel,
		SelectedProvider: selectedProvider,
		Complexity:       complexity,
		Risk:             risk,
		HealthScore:      health,
		FallbackPlan:     fallbackPlan,
		DecisionReason:   strings.Join(reasons, "; "),
		RouteReason:      routeReason,
		ForceProvider:    forceProvider,
	}
}

func (p intelligentRoutingPlan) toStore(requestID, traceID, provider string) *store.RoutingDecisionLog {
	selectedProvider := firstNonEmpty(provider, p.SelectedProvider)
	return &store.RoutingDecisionLog{
		ID:               newID("rdec"),
		RequestID:        requestID,
		TraceID:          traceID,
		RequestedModel:   p.RequestedModel,
		SelectedModel:    p.SelectedModel,
		SelectedProvider: selectedProvider,
		Complexity:       p.Complexity,
		Risk:             p.Risk,
		HealthScore:      p.HealthScore,
		FallbackPath:     p.FallbackPath,
		DecisionReason:   p.DecisionReason,
		CreatedAt:        time.Now().UTC(),
	}
}

func jsonMap(body []byte) map[string]any {
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return nil
	}
	return root
}

func isAutoModelAlias(model string) bool {
	switch strings.ToLower(strings.TrimSpace(model)) {
	case "auto", "vibe/auto", "vibe-coders/auto":
		return true
	default:
		return false
	}
}

func analyzeComplexity(prompts []store.PromptLog, toolCount int) store.ComplexityAnalysis {
	text := promptsPlainText(prompts)
	lower := strings.ToLower(text)
	tokens := audit.EstimateTokens(text)
	promptLength := len([]rune(text))
	conversationDepth := len(prompts)
	codeDensity := codeDensityScore(text)
	fileCount := countUniqueMatches(fileMentionRe, text)
	instructionHits := keywordCount(lower, instructionKeywords)
	reasoningHits := keywordCount(lower, reasoningKeywords)
	refactorHits := keywordCount(lower, refactoringKeywords)
	debugHits := keywordCount(lower, debuggingKeywords)
	norm := func(value, cap float64) float64 {
		if value <= 0 || cap <= 0 {
			return 0
		}
		if value >= cap {
			return 1
		}
		return value / cap
	}
	score := 0.0
	score += 22 * norm(float64(tokens), 8000)
	score += 8 * norm(float64(promptLength), 32000)
	score += 14 * norm(codeDensity, 0.35)
	score += 10 * norm(float64(fileCount), 12)
	score += 10 * norm(float64(conversationDepth), 20)
	score += 8 * norm(float64(toolCount), 10)
	score += 8 * norm(float64(instructionHits), 12)
	score += 10 * norm(float64(reasoningHits), 6)
	score += 6 * norm(float64(refactorHits), 5)
	score += 4 * norm(float64(debugHits), 5)
	if architectureIntent(lower) && score < 85 {
		score = 85
	} else if refactorHits > 0 && score < 60 {
		score = 60
	} else if debugHits > 0 && score < 45 {
		score = 45
	} else if keywordHit(lower, []string{"implement", "create", "generate", "build", "구현", "생성", "작성"}) && score < 30 {
		score = 30
	}
	if score > 100 {
		score = 100
	}
	rounded := int(score + 0.5)
	return store.ComplexityAnalysis{
		Score:               rounded,
		Tier:                complexityTierName(rounded),
		PromptLength:        promptLength,
		TokenEstimate:       tokens,
		CodeDensity:         codeDensity,
		FileCount:           fileCount,
		ConversationDepth:   conversationDepth,
		InstructionDensity:  density(instructionHits, tokens),
		ReasoningKeywords:   reasoningHits,
		RefactoringKeywords: refactorHits,
		DebuggingKeywords:   debugHits,
	}
}

func complexityScore(prompts []store.PromptLog, toolCount int) int {
	return analyzeComplexity(prompts, toolCount).Score
}

func analyzeRisk(prompts []store.PromptLog) store.RiskAnalysis {
	text := promptsPlainText(prompts)
	lower := strings.ToLower(text)
	categories := []string{}
	score := 0
	add := func(category string, weight int) {
		for _, existing := range categories {
			if existing == category {
				return
			}
		}
		categories = append(categories, category)
		score += weight
	}
	if strings.Contains(text, "[REDACTED_RRN]") || strings.Contains(text, "[REDACTED_PHONE") ||
		strings.Contains(text, "[REDACTED_CARD]") || strings.Contains(text, "[REDACTED_EMAIL]") ||
		strings.Contains(text, "[REDACTED_SSN]") {
		add("pii", 35)
	}
	if strings.Contains(text, "[REDACTED_OPENAI_KEY]") || strings.Contains(text, "[REDACTED_ANTHROPIC_KEY]") ||
		strings.Contains(text, "[REDACTED_AWS_ACCESS_KEY]") || strings.Contains(text, "[REDACTED_GITHUB_TOKEN]") ||
		strings.Contains(text, "[REDACTED_SLACK_TOKEN]") || strings.Contains(text, "[REDACTED_GOOGLE_KEY]") ||
		strings.Contains(text, "[REDACTED_JWT]") || strings.Contains(text, "[REDACTED_PRIVATE_KEY]") ||
		strings.Contains(text, "[REDACTED]") {
		add("secret", 40)
	}
	if keywordHit(lower, []string{"api key", "apikey", "access key", "secret key", "bearer ", "token"}) {
		add("api_key", 25)
	}
	if keywordHit(lower, []string{"select ", "insert ", "update ", "delete ", "drop table", "alter table", "truncate ", "grant ", "revoke ", "sql"}) {
		add("sql", 15)
	}
	if keywordHit(lower, []string{"authentication", "authenticate", "login", "oauth", "saml", "jwt", "password", "session cookie", "인증", "로그인"}) {
		add("authentication", 18)
	}
	if keywordHit(lower, []string{"authorization", "permission", "rbac", "acl", "iam", "role policy", "권한", "인가"}) {
		add("authorization", 18)
	}
	if keywordHit(lower, []string{"crypto", "encrypt", "decrypt", "aes", "rsa", "signature", "certificate", "tls", "암호화", "복호화"}) {
		add("crypto", 15)
	}
	if keywordHit(lower, []string{"docker push", "kubectl apply", "helm upgrade", "terraform apply", "deploy", "systemctl", "서비스 배포", "배포"}) {
		add("deployment_command", 20)
	}
	if keywordHit(lower, []string{"rm -rf", "chmod ", "chown ", "iptables", "sudo ", "ssh ", "scp ", "aws ", "gcloud ", "az ", "terraform destroy"}) {
		add("infrastructure_command", 25)
	}
	// Prompt-injection / jailbreak attempts are tracked as their own category so
	// operators can policy/alert on them independent of generic risk.
	if _, injectionScore := detectPromptInjection(text); injectionScore > 0 {
		add("prompt_injection", injectionScore)
	}
	if score > 100 {
		score = 100
	}
	sort.Strings(categories)
	return store.RiskAnalysis{Score: score, Tier: riskTierName(score), Categories: categories}
}

func promptsPlainText(prompts []store.PromptLog) string {
	var b strings.Builder
	for _, p := range prompts {
		text := p.RedactedText
		if text == "" {
			text = p.ContentText
		}
		b.WriteString(text)
		b.WriteByte('\n')
	}
	return b.String()
}

func codeDensityScore(text string) float64 {
	lines := strings.Split(text, "\n")
	if len(lines) == 0 {
		return 0
	}
	codeLines := 0
	for _, line := range lines {
		lower := strings.ToLower(strings.TrimSpace(line))
		if lower == "" {
			continue
		}
		if strings.HasPrefix(lower, "```") || strings.Contains(lower, "{") || strings.Contains(lower, "}") ||
			strings.Contains(lower, ";") || strings.Contains(lower, "=>") ||
			keywordHit(lower, []string{"func ", "function ", "class ", "interface ", "type ", "const ", "let ", "var ", "import ", "package ", "def ", "return ", "if ", "for "}) {
			codeLines++
		}
	}
	return float64(codeLines) / float64(len(lines))
}

func architectureIntent(lower string) bool {
	return keywordHit(lower, []string{
		"architecture", "system design", "tradeoff", "distributed", "scalability", "consistency model",
		"아키텍처", "시스템 설계", "트레이드오프", "분산", "확장성",
	})
}

func countUniqueMatches(re *regexp.Regexp, text string) int {
	matches := re.FindAllString(strings.ToLower(text), -1)
	seen := map[string]bool{}
	for _, m := range matches {
		seen[m] = true
	}
	return len(seen)
}

func keywordCount(lower string, keywords []string) int {
	count := 0
	for _, kw := range keywords {
		count += strings.Count(lower, kw)
	}
	return count
}

func density(hits int, tokens int) float64 {
	if hits <= 0 || tokens <= 0 {
		return 0
	}
	return float64(hits) / float64(tokens)
}

func riskTierName(score int) string {
	switch {
	case score >= 80:
		return "critical"
	case score >= 60:
		return "high"
	case score >= 30:
		return "medium"
	default:
		return "low"
	}
}

func riskDisablesFallback(risk store.RiskAnalysis) bool {
	for _, category := range risk.Categories {
		if category == "pii" || category == "secret" {
			return true
		}
	}
	return false
}

func elevatedTierForRisk(tier string, risk int) string {
	if risk >= 80 {
		return "reasoning"
	}
	if risk >= 60 && tierRank(tier) < tierRank("complex") {
		return "complex"
	}
	if risk >= 30 && tierRank(tier) < tierRank("standard") {
		return "standard"
	}
	return tier
}

func tierRank(tier string) int {
	switch tier {
	case "reasoning":
		return 3
	case "complex":
		return 2
	case "standard":
		return 1
	default:
		return 0
	}
}

func defaultAutoModel(tier string) string {
	switch tier {
	case "reasoning":
		return "o3"
	case "complex":
		return "gpt-4.1"
	case "standard":
		return "gpt-4.1"
	default:
		return "gpt-4.1-mini"
	}
}

func (s *Server) defaultAutoModelForPolicy(tier string, authCtx *store.AuthContext) string {
	candidates := []string{}
	// When the deployment configures an upstream default model, prefer it for every tier so
	// vibe/auto targets the actually-served model instead of the built-in OpenAI names.
	if dm := strings.TrimSpace(s.cfg.Upstream.DefaultModel); dm != "" {
		candidates = append(candidates, dm)
	}
	switch tier {
	case "reasoning":
		candidates = append(candidates, "o3", "gpt-4.1", "gpt-4.1-mini")
	case "complex":
		candidates = append(candidates, "gpt-4.1", "o3", "gpt-4.1-mini")
	case "standard":
		candidates = append(candidates, "gpt-4.1", "gpt-4.1-mini", "o3")
	default:
		candidates = append(candidates, "gpt-4.1-mini", "gpt-4.1", "o3")
	}
	for _, candidate := range candidates {
		if authCtx == nil || listAllows(candidate, authCtx.AllowedModels, authCtx.DeniedModels) {
			return candidate
		}
	}
	return ""
}

func (s *Server) bestProviderForRouting(ctx context.Context, model string, authCtx *store.AuthContext) (string, int) {
	return s.bestProviderForRoutingModels(ctx, []string{model}, authCtx)
}

func (s *Server) bestProviderForRoutingModels(ctx context.Context, models []string, authCtx *store.AuthContext) (string, int) {
	candidates := []string{}
	seen := map[string]bool{}
	for _, model := range models {
		for _, candidate := range providerCandidates(ctx, s, model) {
			if seen[candidate] {
				continue
			}
			seen[candidate] = true
			candidates = append(candidates, candidate)
		}
	}
	if len(candidates) == 0 {
		candidates = []string{s.cfg.Upstream.Provider}
	}
	filtered := candidates[:0]
	for _, candidate := range candidates {
		if authCtx == nil || listAllows(candidate, authCtx.AllowedProviders, authCtx.DeniedProviders) {
			filtered = append(filtered, candidate)
		}
	}
	candidates = filtered
	if len(candidates) == 0 {
		return "", 0
	}
	health := s.providerHealthMap(ctx)
	bestProvider := candidates[0]
	bestScore := 100
	if h, ok := health[bestProvider]; ok {
		bestScore = h.Score
	}
	for _, candidate := range candidates[1:] {
		score := 100
		if h, ok := health[candidate]; ok {
			score = h.Score
		}
		if score > bestScore {
			bestProvider = candidate
			bestScore = score
		}
	}
	return bestProvider, bestScore
}

func providerCandidates(ctx context.Context, s *Server, model string) []string {
	candidates, err := s.providersForModel(ctx, model)
	if err != nil {
		return nil
	}
	return candidates
}

func (s *Server) providerHealthMap(ctx context.Context) map[string]store.ProviderHealthScore {
	// The windowed form is cached. This runs two or three times per request and its cost
	// grows with how much traffic the window holds, so recomputing it per call made the
	// gateway slower the busier it got. See provider_health_cache.go.
	scores, err := s.db.ProviderHealthWindow(ctx, providerHealthWindow)
	if err != nil {
		return map[string]store.ProviderHealthScore{}
	}
	out := map[string]store.ProviderHealthScore{}
	for _, score := range scores {
		out[score.Provider] = score
	}
	return out
}

func (s *Server) healthScoreForProvider(ctx context.Context, provider string) int {
	if provider == "" {
		return 100
	}
	if h, ok := s.providerHealthMap(ctx)[provider]; ok {
		return h.Score
	}
	return 100
}

// routingFallbackPlan describes, before the call is made, what the gateway would do
// if the selected provider fails. It names the concrete providers that would be tried
// and in which order — dialUpstream walks providersForModel in list order (which is
// ORDER BY name ASC), so the plan must reflect that rather than implying a latency- or
// health-based choice.
//
// When only one provider matches the model there is no failover at all. That is the
// single most common surprise in this gateway — a default provider with no
// model_patterns never becomes a candidate — so the plan says so explicitly instead of
// returning a chain that cannot happen.
func (s *Server) routingFallbackPlan(ctx context.Context, model, selectedProvider string) []string {
	plan := []string{}
	candidates, _ := s.providersForModel(ctx, model)
	peers := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate != selectedProvider {
			peers = append(peers, candidate)
		}
	}
	if len(peers) == 0 {
		plan = append(plan, "no_provider_failover:single_matching_provider")
	} else {
		for _, peer := range peers {
			plan = append(plan, "429|5xx|timeout:"+peer)
		}
	}
	if longModel := defaultAutoModel("reasoning"); longModel != "" && longModel != model {
		plan = append(plan, "context_overflow:"+longModel)
	}
	return plan
}

func statusFallbackAllowed(status int) bool {
	return status == http.StatusTooManyRequests || (status >= 500 && status <= 599)
}

func fallbackReasonForStatus(status int) string {
	if status == http.StatusTooManyRequests {
		return "429"
	}
	if status >= 500 && status <= 599 {
		return "5xx"
	}
	return "status_" + itoaProxy(status)
}

func fallbackReasonForError(err error) string {
	if err == nil {
		return ""
	}
	lower := strings.ToLower(err.Error())
	if strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline exceeded") {
		return "timeout"
	}
	return "transport_error"
}

func contextOverflowBody(body []byte) bool {
	lower := strings.ToLower(string(body))
	return strings.Contains(lower, "context_length_exceeded") ||
		strings.Contains(lower, "maximum context length") ||
		strings.Contains(lower, "context window") ||
		strings.Contains(lower, "too many tokens")
}

var instructionKeywords = []string{
	"implement", "create", "write", "add", "change", "modify", "fix", "review", "analyze", "design",
	"구현", "생성", "작성", "추가", "변경", "수정", "고쳐", "검토", "분석", "설계",
}

var reasoningKeywords = []string{
	"architecture", "architect", "design", "tradeoff", "reason", "reasoning", "plan", "prove", "invariant",
	"scalability", "distributed", "consistency", "아키텍처", "설계", "추론", "계획", "트레이드오프", "확장성",
}

var refactoringKeywords = []string{
	"refactor", "cleanup", "clean up", "simplify", "optimize", "rename", "extract", "리팩터", "리팩토링", "정리", "개선", "최적화",
}

var debuggingKeywords = []string{
	"debug", "bug", "error", "exception", "traceback", "stack trace", "failing", "broken", "디버그", "버그", "오류", "에러", "예외", "실패",
}

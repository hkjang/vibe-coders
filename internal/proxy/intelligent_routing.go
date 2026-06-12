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
	RequestedModel   string
	SelectedModel    string
	SelectedProvider string
	Complexity       store.ComplexityAnalysis
	Risk             store.RiskAnalysis
	HealthScore      int
	FallbackPath     []string
	DecisionReason   string
	RouteReason      string
	ForceProvider    bool
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
	fallbackPath := s.routingFallbackPath(ctx, selectedModel, selectedProvider)
	if riskDisablesFallback(risk) {
		fallbackPath = []string{"fallback_disabled:sensitive_data"}
		reasons = append(reasons, "safe fallback disabled for sensitive data risk")
	}

	return intelligentRoutingPlan{
		RequestedModel:   model,
		SelectedModel:    selectedModel,
		SelectedProvider: selectedProvider,
		Complexity:       complexity,
		Risk:             risk,
		HealthScore:      health,
		FallbackPath:     fallbackPath,
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
	switch tier {
	case "reasoning":
		candidates = []string{"o3", "gpt-4.1", "gpt-4.1-mini"}
	case "complex":
		candidates = []string{"gpt-4.1", "o3", "gpt-4.1-mini"}
	case "standard":
		candidates = []string{"gpt-4.1", "gpt-4.1-mini", "o3"}
	default:
		candidates = []string{"gpt-4.1-mini", "gpt-4.1", "o3"}
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
	scores, err := s.db.ProviderHealthScores(ctx, time.Now().Add(-providerHealthWindow))
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

func (s *Server) routingFallbackPath(ctx context.Context, model, selectedProvider string) []string {
	path := []string{}
	candidates, _ := s.providersForModel(ctx, model)
	for _, candidate := range candidates {
		if candidate != selectedProvider {
			path = append(path, "429:"+candidate, "5xx:"+candidate)
			break
		}
	}
	path = append(path, "timeout:lowest-latency-provider", "context_overflow:"+defaultAutoModel("reasoning"))
	return path
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

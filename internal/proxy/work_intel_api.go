package proxy

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// Admin API for work intelligence (docs/WORK_INTELLIGENCE_DESIGN.md, section 7).
// Every route under workIntelAdminPath is registered in Routes() and dispatched
// here; the default admin scope rule applies (GET admin:read, other methods
// admin:write). The contract is published in admin_openapi_work_intel.go, and the
// response shapes are the ones the console parses
// (web/src/shared/api/domains/insights-*.ts).
//
// Three rules hold for every read:
//
//   - A team-scoped administrator is confined to their own teams. The scope is
//     part of the filter every query is built from, so there is no query that
//     could forget it.
//   - A caller who may not see raw prompts gets no user identifier (a stable
//     pseudonym instead) and no distinct-user count below the policy's
//     min_group_size.
//   - The dashboards read the aggregates; see internal/store/work_intel_read.go
//     for when the facts are read instead.
const workIntelAdminPath = "/admin/work-intel"

// workIntelSessionsPrefix starts the path of one session. Routes() dispatches
// it before ServeMux, which would otherwise clean "a/../b" or "a//b" into a
// redirect to another session; the id is the escaped rest of the path,
// decoded once.
const workIntelSessionsPrefix = workIntelAdminPath + "/sessions/"

const (
	workIntelDefaultDays  = 30
	workIntelMaxDays      = 400
	workIntelDefaultLimit = 50
	workIntelMaxLimit     = 500
	// workIntelBodyLimit bounds a request body. The largest is a policy document.
	workIntelBodyLimit = 2 << 20
	// workIntelEngineMaxAge is how long a read may use the compiled policy
	// without asking whether a newer version was published.
	workIntelEngineMaxAge = 5 * time.Second
	// workIntelRestKey is the fold key of everything outside the largest
	// entries. No category id can contain "~".
	workIntelRestKey  = "~rest"
	workIntelRestName = "기타"
)

// workIntelSeoul is the zone the day parameters are in.
var workIntelSeoul = time.FixedZone("KST", 9*3600)

var workIntelMetricIDs = map[string]bool{"sessions": true, "requests": true, "users": true, "tokens": true, "cost": true, "mcp_calls": true}

var workIntelStatuses = []string{workintel.StatusClassified, workintel.StatusReview, workintel.StatusUnclassified, workintel.StatusFailed}

var workIntelMethods = []string{workintel.MethodRule, workintel.MethodLLM, workintel.MethodCache, workintel.MethodManual}

type workIntelHandler func(s *Server, w http.ResponseWriter, r *http.Request, param string)

// workIntelRouteEntry is one path of the API. analytics marks the reads that
// work_intel.analytics_enabled switches off.
type workIntelRouteEntry struct {
	analytics bool
	methods   map[string]workIntelHandler
}

func workIntelGet(analytics bool, h workIntelHandler) workIntelRouteEntry {
	return workIntelRouteEntry{analytics: analytics, methods: map[string]workIntelHandler{http.MethodGet: h}}
}

func workIntelPost(analytics bool, h workIntelHandler) workIntelRouteEntry {
	return workIntelRouteEntry{analytics: analytics, methods: map[string]workIntelHandler{http.MethodPost: h}}
}

// workIntelRoutes maps the path below workIntelAdminPath to its handlers. The
// four parameterised routes are keyed by their template.
var workIntelRoutes map[string]workIntelRouteEntry

func init() {
	workIntelRoutes = map[string]workIntelRouteEntry{
		"overview":               workIntelGet(true, (*Server).handleWorkIntelOverview),
		"categories":             workIntelGet(true, (*Server).handleWorkIntelCategories),
		"trend":                  workIntelGet(true, (*Server).handleWorkIntelTrend),
		"matrix":                 workIntelGet(true, (*Server).handleWorkIntelMatrix),
		"flow":                   workIntelGet(true, (*Server).handleWorkIntelFlow),
		"teams":                  workIntelGet(true, (*Server).handleWorkIntelTeams),
		"models":                 workIntelGet(true, (*Server).handleWorkIntelModels),
		"trends":                 workIntelGet(true, (*Server).handleWorkIntelTrends),
		"automation":             workIntelGet(true, (*Server).handleWorkIntelAutomation),
		"automation/{id}/review": workIntelPost(true, (*Server).handleWorkIntelAutomationReview),
		"insights":               workIntelGet(true, (*Server).handleWorkIntelInsights),
		"insights/run":           workIntelPost(true, (*Server).handleWorkIntelInsightsRun),
		"sessions":               workIntelGet(true, (*Server).handleWorkIntelSessions),
		"sessions/{id}":          workIntelGet(true, (*Server).handleWorkIntelSession),
		"requests":               workIntelGet(true, (*Server).handleWorkIntelRequests),
		"productivity":           workIntelGet(true, (*Server).handleWorkIntelProductivity),
		"export.csv":             workIntelGet(true, (*Server).handleWorkIntelExport),
		"status":                 workIntelGet(false, (*Server).handleWorkIntelStatus),
		"policy": {methods: map[string]workIntelHandler{
			http.MethodGet: (*Server).handleWorkIntelPolicyGet,
			http.MethodPut: (*Server).handleWorkIntelPolicyPut,
		}},
		"policy/versions":           workIntelGet(false, (*Server).handleWorkIntelPolicyVersions),
		"policy/versions/{version}": workIntelGet(false, (*Server).handleWorkIntelPolicyVersion),
		"policy/publish":            workIntelPost(false, (*Server).handleWorkIntelPolicyPublish),
		"policy/rollback":           workIntelPost(false, (*Server).handleWorkIntelPolicyRollback),
		"policy/test":               workIntelPost(false, (*Server).handleWorkIntelPolicyTest),
		"policy/evaluate":           workIntelPost(false, (*Server).handleWorkIntelPolicyEvaluate),
		"review":                    workIntelGet(false, (*Server).handleWorkIntelReview),
		"review/correct":            workIntelPost(false, (*Server).handleWorkIntelCorrect),
		"reclassify": {methods: map[string]workIntelHandler{
			http.MethodGet:  (*Server).handleWorkIntelReclassifyPreview,
			http.MethodPost: (*Server).handleWorkIntelReclassifyStart,
		}},
		"reclassify/jobs/{id}": workIntelGet(false, (*Server).handleWorkIntelReclassifyJob),
		"rebuild":              workIntelPost(false, (*Server).handleWorkIntelRebuild),
	}
}

// workIntelSplitPath resolves a request path to a route key and its path
// parameter. An exact path wins over a template, so "insights/run" is never
// read as a parameter.
func workIntelSplitPath(path string) (route, param string, ok bool) {
	rest := strings.TrimPrefix(path, workIntelAdminPath+"/")
	if rest == path || rest == "" {
		return "", "", false
	}
	if _, exact := workIntelRoutes[rest]; exact && !strings.Contains(rest, "{") {
		return rest, "", true
	}
	for _, template := range []struct{ prefix, suffix, route string }{
		{"automation/", "/review", "automation/{id}/review"},
		{"sessions/", "", "sessions/{id}"},
		{"policy/versions/", "", "policy/versions/{version}"},
		{"reclassify/jobs/", "", "reclassify/jobs/{id}"},
	} {
		if !strings.HasPrefix(rest, template.prefix) || !strings.HasSuffix(rest, template.suffix) {
			continue
		}
		if param = strings.TrimSuffix(strings.TrimPrefix(rest, template.prefix), template.suffix); param != "" {
			return template.route, param, true
		}
	}
	return "", "", false
}

func (s *Server) handleWorkIntel(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	route, param, ok := workIntelSplitPath(r.URL.Path)
	if ok && route == "sessions/{id}" {
		// Every byte after the prefix belongs to the id, as the client encoded it.
		raw := strings.TrimPrefix(r.URL.EscapedPath(), workIntelSessionsPrefix)
		decoded, err := url.PathUnescape(raw)
		if err != nil || raw == r.URL.EscapedPath() {
			workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", "the session id is not a valid path segment")
			return
		}
		param = decoded
	}
	if !ok {
		workIntelError(w, http.StatusNotFound, "work_intel_not_found", "no such work intelligence resource")
		return
	}
	entry := workIntelRoutes[route]
	handler := entry.methods[r.Method]
	if handler == nil {
		allowed := make([]string, 0, len(entry.methods))
		for method := range entry.methods {
			allowed = append(allowed, method)
		}
		sort.Strings(allowed)
		w.Header().Set("Allow", strings.Join(allowed, ", "))
		workIntelError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	// The status and the policy routes stay available while analytics is off, so
	// an operator can see why the screen is empty and switch it back on.
	if entry.analytics && !s.workIntelConf().AnalyticsEnabled {
		workIntelError(w, http.StatusServiceUnavailable, "work_intel_analytics_disabled",
			"work usage analytics is switched off (work_intel.analytics_enabled)")
		return
	}
	handler(s, w, r, param)
}

func workIntelError(w http.ResponseWriter, status int, code, message string) {
	kind := "invalid_request_error"
	switch {
	case status >= 500:
		kind = "server_error"
	case status == http.StatusForbidden:
		kind = "permission_error"
	}
	writeOpenAIError(w, status, message, kind, code)
}

// workIntelFailed reports a failure of the store without its text: a database
// error can quote identifiers and values.
func workIntelFailed(w http.ResponseWriter, r *http.Request, what string, err error) {
	if errors.Is(err, context.Canceled) || r.Context().Err() != nil {
		workIntelError(w, http.StatusServiceUnavailable, "work_intel_cancelled", "the request was cancelled")
		return
	}
	slog.Warn("work intel: "+what+" failed", "error", err)
	workIntelError(w, http.StatusInternalServerError, "work_intel_failed", what+" could not be completed")
}

// workIntelDecode reads a JSON body into dst. It reports false after writing
// the error response.
func workIntelDecode(w http.ResponseWriter, r *http.Request, dst any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, workIntelBodyLimit))
	if err != nil {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "the request body is too large or could not be read")
		return false
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "the request body is not valid JSON")
		return false
	}
	return true
}

// ---- Caller ----

// workIntelCaller is what the caller may see.
type workIntelCaller struct {
	// teams is the caller's whole world when scoped is true.
	teams  []string
	scoped bool
	// privileged callers may see user identifiers and groups of any size.
	privileged bool
	actor      string
}

func (s *Server) workIntelCallerOf(w http.ResponseWriter, r *http.Request) (workIntelCaller, bool) {
	teams, scoped, err := requestTeamScopeForCallerChecked(s, r)
	if err != nil {
		workIntelError(w, http.StatusInternalServerError, "work_intel_scope_failed", "the caller's team scope could not be resolved")
		return workIntelCaller{}, false
	}
	return workIntelCaller{teams: teams, scoped: scoped, privileged: s.canViewRawPrompts(r), actor: s.adminKeyActor(r)}, true
}

// allows reports whether the caller may see a team's data.
func (c workIntelCaller) allows(team string) bool {
	if !c.scoped {
		return true
	}
	for _, own := range c.teams {
		if own == team {
			return true
		}
	}
	return false
}

// requireGlobal refuses a team-scoped caller for an operation that concerns
// every team (the policy, the aggregates of whole days).
func (c workIntelCaller) requireGlobal(w http.ResponseWriter) bool {
	if c.scoped {
		workIntelError(w, http.StatusForbidden, "work_intel_forbidden", "this operation is not available to a team-scoped administrator")
		return false
	}
	return true
}

// workIntelUserPrefix starts every user pseudonym.
const workIntelUserPrefix = "사용자-"

// workIntelPseudonymKey is the key of the user pseudonyms: the gateway secret,
// or else the JWT secret. The public development default is no secret at all
// (dlpFingerprintKey treats it the same way): a pseudonym keyed with it could
// be recomputed by anyone from a list of user ids. Without a secret of this
// deployment's own the key is nil and no pseudonym is made.
func (s *Server) workIntelPseudonymKey() []byte {
	for _, secret := range []string{s.cfg.Secret.GatewaySecret, s.cfg.Auth.JWTSecret} {
		if secret = strings.TrimSpace(secret); secret != "" && secret != config.DefaultGatewaySecret {
			return []byte(secret)
		}
	}
	return nil
}

// workIntelPseudonym is the stable stand-in for a user identifier shown to
// callers who may not see who the user is. It is keyed with a secret of this
// deployment, so it cannot be recomputed from a list of known user ids. It is
// empty when there is no such secret: the user is then not labelled at all.
func (s *Server) workIntelPseudonym(userKey string) string {
	key := s.workIntelPseudonymKey()
	if userKey == "" || key == nil {
		return ""
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("work-intel-user-v1\x00"))
	mac.Write([]byte(userKey))
	return workIntelUserPrefix + hex.EncodeToString(mac.Sum(nil))[:10]
}

func (s *Server) workIntelUserLabel(c workIntelCaller, userKey string) string {
	if c.privileged {
		return userKey
	}
	return s.workIntelPseudonym(userKey)
}

// ---- Analytics query ----

type workIntelScope struct {
	From            string `json:"from"`
	To              string `json:"to"`
	PrevFrom        string `json:"prev_from"`
	PrevTo          string `json:"prev_to"`
	TeamScoped      bool   `json:"team_scoped"`
	MinGroupSize    int    `json:"min_group_size"`
	DataThrough     string `json:"data_through"`
	Backlog         int64  `json:"backlog"`
	ClassifyEnabled bool   `json:"classify_enabled"`
	PolicyVersion   int    `json:"policy_version"`
	// SmallGroupsWithheld says the caller may not see raw prompts: groups of
	// fewer than MinGroupSize users are withheld and the classification-quality
	// distributions of /overview are not given (work_intel_guard.go).
	SmallGroupsWithheld bool `json:"small_groups_withheld"`
}

// workIntelReadQuery is a parsed analytics request: the period, the filters with
// the caller's scope already applied, and the policy the answer is presented in.
type workIntelReadQuery struct {
	s      *Server
	caller workIntelCaller
	engine *workintel.Engine
	// version is the published policy version the engine was compiled from.
	version int

	from, to         string
	prevFrom, prevTo string
	compare          bool
	metric           string
	limit, offset    int
	// base carries every filter but the period and the categories.
	base store.WorkFilter
	// category is the canonical id of the category filter, or empty.
	category string
	minGroup int
	scope    workIntelScope

	idCache map[string]map[string]string
}

type workIntelBadQuery struct{ message string }

func (e workIntelBadQuery) Error() string { return e.message }

func workIntelParseDay(value string) (time.Time, bool) {
	if len(value) != 10 {
		return time.Time{}, false
	}
	day, err := time.ParseInLocation("2006-01-02", value, workIntelSeoul)
	return day, err == nil
}

func workIntelFormatDay(t time.Time) string {
	return t.In(workIntelSeoul).Format("2006-01-02")
}

// workIntelPeriod reads from/to. The default is the last defaultDays Seoul days
// ending today; one bound alone anchors a period of that length. maxDays caps
// the length.
func workIntelPeriod(r *http.Request, defaultDays, maxDays int) (from, to time.Time, err error) {
	query := r.URL.Query()
	rawFrom, rawTo := strings.TrimSpace(query.Get("from")), strings.TrimSpace(query.Get("to"))
	today, _ := workIntelParseDay(store.WorkIntelDay(time.Now()))
	var okFrom, okTo bool
	if rawFrom != "" {
		if from, okFrom = workIntelParseDay(rawFrom); !okFrom {
			return from, to, workIntelBadQuery{"from must be a day (YYYY-MM-DD)"}
		}
	}
	if rawTo != "" {
		if to, okTo = workIntelParseDay(rawTo); !okTo {
			return from, to, workIntelBadQuery{"to must be a day (YYYY-MM-DD)"}
		}
	}
	switch {
	case okFrom && okTo:
	case okFrom:
		to = from.AddDate(0, 0, defaultDays-1)
		if to.After(today) {
			to = today
		}
	case okTo:
		from = to.AddDate(0, 0, -(defaultDays - 1))
	default:
		to = today
		from = to.AddDate(0, 0, -(defaultDays - 1))
	}
	if from.After(to) {
		return from, to, workIntelBadQuery{"from must not be after to"}
	}
	if days := workIntelDaysBetween(from, to); days > maxDays {
		return from, to, workIntelBadQuery{fmt.Sprintf("the period must not be longer than %d days", maxDays)}
	}
	return from, to, nil
}

// workIntelDaysBetween counts the days of an inclusive day range.
func workIntelDaysBetween(from, to time.Time) int {
	return int(to.Sub(from).Hours()/24+0.5) + 1
}

func workIntelText(r *http.Request, name string, max int) (string, error) {
	value := strings.TrimSpace(r.URL.Query().Get(name))
	if len(value) > max || strings.ContainsAny(value, "\x00\r\n") {
		return "", workIntelBadQuery{fmt.Sprintf("%s must be a single line of at most %d bytes", name, max)}
	}
	return value, nil
}

func workIntelInt(r *http.Request, name string, fallback, min, max int) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < min || value > max {
		return 0, workIntelBadQuery{fmt.Sprintf("%s must be an integer from %d to %d", name, min, max)}
	}
	return value, nil
}

func workIntelConfidence(r *http.Request, name string) (*float64, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, nil
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(value) || value < 0 || value > 1 {
		return nil, workIntelBadQuery{name + " must be a number from 0 to 1"}
	}
	return &value, nil
}

func workIntelOneOf(r *http.Request, name string, allowed []string, max int) (string, error) {
	value, err := workIntelText(r, name, max)
	if err != nil || value == "" {
		return value, err
	}
	for _, option := range allowed {
		if value == option {
			return value, nil
		}
	}
	return "", workIntelBadQuery{fmt.Sprintf("%s must be one of %s", name, strings.Join(allowed, ", "))}
}

// workIntelQueryOptions tells the parser which parameters a route reads
// differently from the common ones.
type workIntelQueryOptions struct {
	// statusIsReview: status filters automation candidates by review state and
	// is not a classification status.
	statusIsReview bool
	defaultDays    int
	// exportLimit: limit caps the rows of a file rather than the size of a page.
	exportLimit bool
}

// workIntelAnalytics parses the common analytics parameters, applies the
// caller's scope and builds the response scope. It reports false after
// writing the error response.
func (s *Server) workIntelAnalytics(w http.ResponseWriter, r *http.Request, opts workIntelQueryOptions) (*workIntelReadQuery, bool) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok {
		return nil, false
	}
	q, err := s.workIntelBuildQuery(r, caller, opts)
	var bad workIntelBadQuery
	var denied workIntelDenied
	switch {
	case errors.As(err, &bad):
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", bad.message)
		return nil, false
	case errors.As(err, &denied):
		status := denied.status
		if status == 0 {
			status = http.StatusForbidden
		}
		workIntelError(w, status, denied.code, denied.message)
		return nil, false
	case err != nil:
		workIntelFailed(w, r, "reading the work intelligence state", err)
		return nil, false
	}
	return q, true
}

// workIntelDenied refuses a query with its own code: 403 unless status says
// otherwise.
type workIntelDenied struct {
	status        int
	code, message string
}

func (e workIntelDenied) Error() string { return e.message }

func (s *Server) workIntelBuildQuery(r *http.Request, caller workIntelCaller, opts workIntelQueryOptions) (*workIntelReadQuery, error) {
	ctx := r.Context()
	if opts.defaultDays <= 0 {
		opts.defaultDays = workIntelDefaultDays
	}
	from, to, err := workIntelPeriod(r, opts.defaultDays, workIntelMaxDays)
	if err != nil {
		return nil, err
	}
	q := &workIntelReadQuery{s: s, caller: caller, from: workIntelFormatDay(from), to: workIntelFormatDay(to), idCache: map[string]map[string]string{}}
	switch compare := strings.TrimSpace(r.URL.Query().Get("compare")); compare {
	case "", "prev":
		q.compare = true
		days := workIntelDaysBetween(from, to)
		q.prevTo = workIntelFormatDay(from.AddDate(0, 0, -1))
		q.prevFrom = workIntelFormatDay(from.AddDate(0, 0, -days))
	case "none":
	default:
		return nil, workIntelBadQuery{"compare must be prev or none"}
	}
	if q.metric, err = workIntelText(r, "metric", 32); err != nil {
		return nil, err
	}
	if q.metric == "" {
		q.metric = "sessions"
	}
	if !workIntelMetricIDs[q.metric] {
		return nil, workIntelBadQuery{"metric must be one of sessions, requests, users, tokens, cost, mcp_calls"}
	}
	defaultLimit, maxLimit := workIntelDefaultLimit, workIntelMaxLimit
	if opts.exportLimit {
		defaultLimit, maxLimit = workIntelExportDefaultRows, workIntelExportMaxRows
	}
	if q.limit, err = workIntelInt(r, "limit", defaultLimit, 1, maxLimit); err != nil {
		return nil, err
	}
	if q.offset, err = workIntelInt(r, "offset", 0, 0, math.MaxInt32); err != nil {
		return nil, err
	}
	// A list's count stops at store.WorkCountCap, so no page lies beyond it, and
	// an offset the database would have to skip past every row of a long period
	// to answer is refused rather than run.
	if q.offset > store.WorkCountCap {
		return nil, workIntelDenied{status: http.StatusBadRequest, code: "work_intel_offset_too_large",
			message: fmt.Sprintf("offset must not be greater than %d, where list counts stop", store.WorkCountCap)}
	}

	team, err := workIntelText(r, "team", 128)
	if err != nil {
		return nil, err
	}
	q.base.Teams, q.base.TeamScoped = caller.teams, caller.scoped
	if team != "" {
		if !caller.allows(team) {
			return nil, workIntelDenied{code: "work_intel_team_forbidden", message: "a team-scoped administrator can only read their own team"}
		}
		q.base.Teams = []string{team}
	}
	for _, field := range []struct {
		name string
		max  int
		into *string
	}{
		{"action", 32, &q.base.Action}, {"model", 160, &q.base.Model}, {"provider", 128, &q.base.Provider},
		{"client", 128, &q.base.Client}, {"tool", 160, &q.base.Tool},
	} {
		if *field.into, err = workIntelText(r, field.name, field.max); err != nil {
			return nil, err
		}
	}
	if !opts.statusIsReview {
		status, err := workIntelOneOf(r, "status", workIntelStatuses, 32)
		if err != nil {
			return nil, err
		}
		if status != "" {
			q.base.Statuses = []string{status}
		}
	}
	if q.base.Method, err = workIntelOneOf(r, "method", workIntelMethods, 32); err != nil {
		return nil, err
	}
	if q.base.MinConfidence, err = workIntelConfidence(r, "min_conf"); err != nil {
		return nil, err
	}
	if q.base.MaxConfidence, err = workIntelConfidence(r, "max_conf"); err != nil {
		return nil, err
	}
	if q.base.MinConfidence != nil && q.base.MaxConfidence != nil && *q.base.MinConfidence > *q.base.MaxConfidence {
		return nil, workIntelBadQuery{"min_conf must not be greater than max_conf"}
	}

	snap, err := s.workIntelActiveEngine(ctx, workIntelEngineMaxAge)
	if err != nil {
		return nil, fmt.Errorf("load work policy: %w", err)
	}
	q.engine, q.version = snap.engine, snap.version
	q.minGroup = q.engine.Thresholds().MinGroupSize
	if q.minGroup < 1 {
		q.minGroup = 1
	}
	category, err := workIntelText(r, "category", 128)
	if err != nil {
		return nil, err
	}
	q.setCategory(category)

	user, err := workIntelText(r, "user", 128)
	if err != nil {
		return nil, err
	}
	if user != "" {
		if q.base.User, err = q.resolveUser(ctx, user); err != nil {
			return nil, err
		}
	}

	state, err := s.db.GetWorkIntelState(ctx)
	if err != nil {
		return nil, fmt.Errorf("read work intel state: %w", err)
	}
	backlog, _, _, err := s.db.WorkIntelBacklog(ctx)
	if err != nil {
		return nil, fmt.Errorf("count work intel backlog: %w", err)
	}
	q.scope = workIntelScope{
		From: q.from, To: q.to, PrevFrom: q.prevFrom, PrevTo: q.prevTo, TeamScoped: caller.scoped, MinGroupSize: q.minGroup,
		DataThrough: state.Cursor.IngestedAt, Backlog: backlog, ClassifyEnabled: s.workIntelConf().ClassifyEnabled, PolicyVersion: q.version,
		SmallGroupsWithheld: !caller.privileged,
	}
	return q, nil
}

// workIntelNoUser is a user key nobody has: the filter of a pseudonym that
// matches no active user.
const workIntelNoUser = "\x01no-such-user"

// resolveUser turns the user parameter into a stored user key. A caller who
// may see users names one directly. Anyone else may only pass a pseudonym they
// were shown: accepting a real identifier would let them test who is behind a
// pseudonym.
func (q *workIntelReadQuery) resolveUser(ctx context.Context, user string) (string, error) {
	if q.caller.privileged {
		return user, nil
	}
	if !strings.HasPrefix(user, workIntelUserPrefix) {
		return "", workIntelDenied{code: "work_intel_user_filter_forbidden", message: "users can only be filtered by the pseudonym shown in the lists"}
	}
	if q.s.workIntelPseudonymKey() == nil {
		// No pseudonym was shown, so none can name a user.
		return workIntelNoUser, nil
	}
	keys, err := q.s.db.WorkUserKeys(ctx, store.WorkFilter{From: q.from, To: q.to, Teams: q.base.Teams, TeamScoped: q.base.TeamScoped}, 0)
	if err != nil {
		return "", err
	}
	for _, key := range keys {
		if q.s.workIntelPseudonym(key) == user {
			return key, nil
		}
	}
	return workIntelNoUser, nil
}

// ---- Categories as they are reported ----

// setCategory applies the category filter. A registered category is replaced
// by the one that stands for it now. An id the policy does not have selects
// nothing: resolving it the way a stored row is resolved would turn a typo
// into "other".
func (q *workIntelReadQuery) setCategory(id string) {
	switch {
	case id == "":
		q.category = ""
	case q.engine.Known(id):
		q.category = q.engine.Canonical(id)
	default:
		q.category = id
	}
}

// under reports whether a stored category id is reported under the canonical
// category parent: the category itself, a descendant, or something merged
// into either.
func (q *workIntelReadQuery) under(id, parent string) bool {
	canonical := q.engine.Canonical(id)
	return parent == "" || canonical == parent || strings.HasPrefix(canonical, parent+".")
}

// usedIDs returns the stored category ids the caller's teams used between two
// days, each with the first day it was used in that range. Only ids under the
// category filter are returned. Stored rows keep the id they were classified
// with, so this is the set every fold and every category filter is built from.
func (q *workIntelReadQuery) usedIDs(ctx context.Context, from, to string) (map[string]string, error) {
	key := from + "|" + to
	if cached, ok := q.idCache[key]; ok {
		return cached, nil
	}
	first, err := q.s.db.WorkCategoryFirstDays(ctx, store.WorkFilter{From: from, To: to, Teams: q.base.Teams, TeamScoped: q.base.TeamScoped})
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for id, day := range first {
		if q.under(id, q.category) {
			out[id] = day
		}
	}
	q.idCache[key] = out
	return out, nil
}

// filter returns the store filter for a period. With a category filter it
// names the stored ids reported under that category, starting from the
// engine's own expansion so that ids the policy knows are included even
// before the first read of a period.
func (q *workIntelReadQuery) filter(ctx context.Context, from, to string) (store.WorkFilter, error) {
	f := q.base
	f.From, f.To = from, to
	if q.category == "" {
		return f, nil
	}
	used, err := q.usedIDs(ctx, from, to)
	if err != nil {
		return f, err
	}
	seen := map[string]bool{}
	f.Categories = []string{}
	for _, id := range q.engine.Descendants(q.category) {
		if q.under(id, q.category) && !seen[id] {
			seen[id] = true
			f.Categories = append(f.Categories, id)
		}
	}
	for id := range used {
		if !seen[id] {
			seen[id] = true
			f.Categories = append(f.Categories, id)
		}
	}
	sort.Strings(f.Categories)
	return f, nil
}

// fold maps stored category ids to the key they are reported under at one
// level: the top-level categories for an empty parent, otherwise the children
// of parent, with requests classified at the parent itself under the parent's
// own id. Ids outside the level get no key.
func (q *workIntelReadQuery) fold(ids map[string]string, parent string) map[string]string {
	out := map[string]string{}
	for id := range ids {
		canonical := q.engine.Canonical(id)
		switch {
		case parent == "":
			out[id] = workIntelTopOf(canonical)
		case canonical == parent:
			out[id] = parent
		case strings.HasPrefix(canonical, parent+"."):
			rest := canonical[len(parent)+1:]
			if i := strings.IndexByte(rest, '.'); i >= 0 {
				rest = rest[:i]
			}
			out[id] = parent + "." + rest
		}
	}
	return out
}

// level is the fold a breakdown uses when the request does not name a parent:
// the children of the category filter when there is one, otherwise the top level.
func (q *workIntelReadQuery) level(ids map[string]string) (fold map[string]string, parent string) {
	return q.fold(ids, q.category), q.category
}

func workIntelTopOf(id string) string {
	if i := strings.IndexByte(id, '.'); i > 0 {
		return id[:i]
	}
	return id
}

// ref describes the category behind a fold key. At a child level the parent's
// own id stands for the requests that were not classified any deeper; the
// name says so, because otherwise the row would read as the whole parent.
func (q *workIntelReadQuery) ref(key, parent string) workintel.CategoryRef {
	ref := q.engine.Ref(key)
	if parent != "" && key == parent && q.hasChildren(parent) {
		ref.Name += " (세부 분류 없음)"
	}
	return ref
}

// hasChildren reports whether a category has children that are reported
// under their own id (not merged away).
func (q *workIntelReadQuery) hasChildren(id string) bool {
	for _, child := range q.engine.Children(id) {
		if q.engine.Canonical(child.ID) == child.ID {
			return true
		}
	}
	return false
}

func workIntelFoldKeys(fold map[string]string) []string {
	seen := map[string]bool{}
	keys := []string{}
	for _, key := range fold {
		if key != "" && !seen[key] {
			seen[key] = true
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}

// workIntelFoldIDs returns the stored ids a fold reports, optionally only
// those of the given keys.
func workIntelFoldIDs(fold map[string]string, keys map[string]bool) []string {
	ids := []string{}
	for id, key := range fold {
		if key != "" && (keys == nil || keys[key]) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// ---- Measures ----

// workMetrics is the Metrics object of the contract. A group the caller may
// not be shown is Suppressed, and is sent with every measure null
// (work_intel_guard.go).
type workMetrics struct {
	Sessions   int64   `json:"sessions"`
	Requests   int64   `json:"requests"`
	Users      *int64  `json:"users"`
	Tokens     int64   `json:"tokens"`
	CostKRW    float64 `json:"cost_krw"`
	MCPCalls   int64   `json:"mcp_calls"`
	Suppressed bool    `json:"suppressed"`
}

// workCell is everything measured for one group.
type workCell struct {
	store.WorkSums
	Sessions int64
	Users    int64
}

type workNeed struct{ sessions, users bool }

var workNeedBoth = workNeed{sessions: true, users: true}

// needFor returns the distinct counts a metric is computed from.
func workNeedFor(metric string) workNeed {
	return workNeed{sessions: metric == "sessions", users: metric == "users"}
}

// measure reads the additive measures of a grouping and, as asked, its
// distinct sessions and users, keyed by group.
func (s *Server) workIntelMeasure(ctx context.Context, f store.WorkFilter, g store.WorkGroup, need workNeed) (map[store.WorkKey]*workCell, error) {
	cells := map[store.WorkKey]*workCell{}
	cell := func(key store.WorkKey) *workCell {
		c := cells[key]
		if c == nil {
			c = &workCell{}
			c.WorkKey = key
			cells[key] = c
		}
		return c
	}
	sums, err := s.db.WorkSums(ctx, f, g)
	if err != nil {
		return nil, err
	}
	for _, sum := range sums {
		cell(sum.WorkKey).WorkSums = sum
	}
	if need.sessions {
		counts, err := s.db.WorkSessionCounts(ctx, f, g)
		if err != nil {
			return nil, err
		}
		for _, count := range counts {
			cell(count.WorkKey).Sessions = count.Count
		}
	}
	if need.users {
		counts, err := s.db.WorkUserCounts(ctx, f, g)
		if err != nil {
			return nil, err
		}
		for _, count := range counts {
			cell(count.WorkKey).Users = count.Count
		}
	}
	return cells, nil
}

// measureOne measures a filter as a single group.
func (s *Server) workIntelMeasureOne(ctx context.Context, f store.WorkFilter) (workCell, error) {
	cells, err := s.workIntelMeasure(ctx, f, store.WorkGroup{}, workNeedBoth)
	if err != nil {
		return workCell{}, err
	}
	if c := cells[store.WorkKey{}]; c != nil {
		return *c, nil
	}
	return workCell{}, nil
}

// small reports whether a group of this many distinct users is too small to
// show the caller anything about (the primary rule of work_intel_guard.go).
func (q *workIntelReadQuery) small(users int64) bool {
	return !q.caller.privileged && users > 0 && users < int64(q.minGroup)
}

// userCount returns a distinct-user count as the caller may see it.
func (q *workIntelReadQuery) userCount(users int64) *int64 {
	if q.small(users) {
		return nil
	}
	return &users
}

// need returns the distinct counts a shown breakdown reads: those the metric is
// made of, and the users wherever the caller may be refused a small group.
func (q *workIntelReadQuery) need(metric string) workNeed {
	need := workNeedFor(metric)
	if !q.caller.privileged {
		need.users = true
	}
	return need
}

// metrics presents a group that is withheld only when it is small itself.
func (q *workIntelReadQuery) metrics(c workCell) workMetrics {
	return q.metricsOf(c, q.small(c.Users))
}

// metricsOf presents a group, withheld as the guard decided.
func (q *workIntelReadQuery) metricsOf(c workCell, withheld bool) workMetrics {
	if withheld {
		return workMetrics{Suppressed: true}
	}
	return workMetrics{
		Sessions: c.Sessions, Requests: c.Requests, Users: q.userCount(c.Users),
		Tokens: c.TokensIn + c.TokensOut, CostKRW: workIntelRound(c.CostKRW), MCPCalls: c.MCPCalls,
	}
}

// workIntelRound keeps amounts to two decimals: sums of stored costs carry
// floating-point noise that would otherwise show up in the JSON.
func workIntelRound(v float64) float64 {
	return math.Round(v*100) / 100
}

// workIntelRatio keeps a ratio to four decimals.
func workIntelRatio(v float64) float64 {
	return math.Round(v*10000) / 10000
}

// value returns a cell in the selected metric. It is the true value: what
// the caller is shown of it is decided by the guard of the response.
func (q *workIntelReadQuery) value(c workCell) float64 {
	return q.valueOf(c, q.metric)
}

func (q *workIntelReadQuery) valueOf(c workCell, metric string) float64 {
	switch metric {
	case "requests":
		return float64(c.Requests)
	case "users":
		return float64(c.Users)
	case "tokens":
		return float64(c.TokensIn + c.TokensOut)
	case "cost":
		return workIntelRound(c.CostKRW)
	case "mcp_calls":
		return float64(c.MCPCalls)
	}
	return float64(c.Sessions)
}

// change returns the relative change of the selected metric from previous to
// current, or nil without a base. A user count that is withheld on either
// side has no change to report: it would be computed from a number the caller
// is not shown.
func (q *workIntelReadQuery) change(current, previous workCell) *float64 {
	if q.metric == "users" && (q.small(current.Users) || q.small(previous.Users)) {
		return nil
	}
	return workIntelRelativeChange(q.value(current), q.value(previous))
}

// additive reports whether a metric can be summed over groups. Sessions and
// users are distinct counts: a session or a user can be in several groups.
func workIntelAdditive(metric string) bool {
	return metric != "sessions" && metric != "users"
}

// relativeChange returns (current-previous)/previous, or nil without a base.
func workIntelRelativeChange(current, previous float64) *float64 {
	if previous == 0 {
		return nil
	}
	change := workIntelRatio((current - previous) / previous)
	return &change
}

// workIntelDayList lists the days of an inclusive range.
func workIntelDayList(from, to string) []string {
	start, ok1 := workIntelParseDay(from)
	end, ok2 := workIntelParseDay(to)
	out := []string{}
	if !ok1 || !ok2 {
		return out
	}
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		out = append(out, workIntelFormatDay(day))
	}
	return out
}

func workIntelShiftDay(day string, days int) string {
	t, ok := workIntelParseDay(day)
	if !ok {
		return day
	}
	return workIntelFormatDay(t.AddDate(0, 0, days))
}

// workIntelClip bounds a free-text field of a request body.
func workIntelClip(value string, maxRunes int) (string, bool) {
	value = strings.TrimSpace(value)
	return value, utf8.RuneCountInString(value) <= maxRunes
}

// handleWorkIntelStatus reports the state of the classification worker. It is
// the one read that works while analytics is off.
func (s *Server) handleWorkIntelStatus(w http.ResponseWriter, r *http.Request, _ string) {
	status, err := s.workIntelStatus(r.Context())
	if err != nil {
		workIntelFailed(w, r, "reading the worker status", err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

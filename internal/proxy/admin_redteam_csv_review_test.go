package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func probeImportReviewRequest(s *Server, method, path, body, revision, actor string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "text/csv; charset=utf-8")
	if revision != "" {
		r.Header.Set("If-Match", "\""+revision+"\"")
	}
	if actor != "" {
		r.Header.Set("Authorization", "Bearer "+actor)
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, r)
	return w
}

func probeReviewBody(t *testing.T, before store.RedTeamProbePack) string {
	t.Helper()
	row := probeCSVPublicRow("public-edited", "reviewed prompt")
	row[0], row[1], row[6] = before.ID, "reviewed pack", "editable"
	return probeCSVRecordsBody(t, [][]string{strings.Split(probeCSVPublicHeader, ","), row})
}

func probeReviewRevision(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	if w.Code != http.StatusOK {
		t.Fatalf("review status=%d body=%s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	revision, ok := body["revision"].(string)
	if !ok || len(revision) != 64 {
		t.Fatal("missing exact-state revision")
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("ETag") != "\""+revision+"\"" {
		t.Fatal("review cache/etag contract missing")
	}
	return revision
}

func TestRedTeamProbeCSVReviewDoesNotWriteAndApplyIsBound(t *testing.T) {
	s, db, raw, _ := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("import review invoked upstream") })
	before := seedProbeMetadata(t, db)
	body := probeReviewBody(t, before)
	snapshot, err := db.ListRedTeamProbePacks(t.Context(), true)
	if err != nil {
		t.Fatal(err)
	}
	review := probeImportReviewRequest(s, http.MethodPost, "/admin/redteam/probe-packs/import-review", body, "", "operator")
	revision := probeReviewRevision(t, review)
	if strings.Contains(review.Body.String(), "parameters") || strings.Contains(review.Body.String(), "original-actor") {
		t.Error("review exposed unrepresented execution parameters/provenance")
	}
	if !strings.Contains(review.Body.String(), "original prompt") || !strings.Contains(review.Body.String(), "reviewed prompt") {
		t.Error("review lacks before/after content")
	}
	after, err := db.ListRedTeamProbePacks(t.Context(), true)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(snapshot, after) || csvImportAuditCount(t, raw) != 0 {
		t.Fatal("review mutated catalogue or emitted an apply audit")
	}
	for _, tc := range []struct {
		name, revision, body, actor string
		status                      int
	}{
		{"missing", "", body, "operator", 400},
		{"stale", strings.Repeat("0", 64), body, "operator", 409},
		{"changed-file", revision, strings.Replace(body, "reviewed prompt", "different prompt", 1), "operator", 409},
		{"other-actor", revision, body, "other-operator", 409},
	} {
		response := probeImportReviewRequest(s, http.MethodPut, "/admin/redteam/probe-packs/import", tc.body, tc.revision, tc.actor)
		if response.Code != tc.status {
			t.Errorf("%s status=%d want=%d", tc.name, response.Code, tc.status)
		}
	}
	after, err = db.ListRedTeamProbePacks(t.Context(), true)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(snapshot, after) || csvImportAuditCount(t, raw) != 0 {
		t.Fatal("rejected apply changed catalogue")
	}
	applied := probeImportReviewRequest(s, http.MethodPut, "/admin/redteam/probe-packs/import", body, revision, "operator")
	if applied.Code != http.StatusOK {
		t.Fatalf("apply status=%d body=%s", applied.Code, applied.Body.String())
	}
	assertProbeMetadata(t, before, probeMetadataPack(t, db, before.ID), "reviewed prompt")
	if csvImportAuditCount(t, raw) != 1 {
		t.Fatal("apply must have exactly one audit")
	}
	replay := probeImportReviewRequest(s, http.MethodPut, "/admin/redteam/probe-packs/import", body, revision, "operator")
	if replay.Code != http.StatusConflict || csvImportAuditCount(t, raw) != 1 {
		t.Fatal("already-applied revision replayed")
	}
}

func TestRedTeamProbeCSVReviewConcurrentApply(t *testing.T) {
	s, db, raw, _ := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected upstream") })
	body := probeReviewBody(t, seedProbeMetadata(t, db))
	revision := probeReviewRevision(t, probeImportReviewRequest(s, "POST", "/admin/redteam/probe-packs/import-review", body, "", "operator"))
	start := make(chan struct{})
	outcomes := make(chan int, 4)
	var workers sync.WaitGroup
	for range 4 {
		workers.Go(func() {
			<-start
			outcomes <- probeImportReviewRequest(s, "PUT", "/admin/redteam/probe-packs/import", body, revision, "operator").Code
		})
	}
	close(start)
	workers.Wait()
	close(outcomes)
	accepted, conflicts := 0, 0
	for status := range outcomes {
		switch status {
		case 200:
			accepted++
		case 409:
			conflicts++
		default:
			t.Errorf("unexpected concurrent outcome %d", status)
		}
	}
	if accepted != 1 || conflicts != 3 || csvImportAuditCount(t, raw) != 1 {
		t.Fatalf("accepted=%d conflicts=%d audits=%d", accepted, conflicts, csvImportAuditCount(t, raw))
	}
}

func TestRedTeamProbeCSVReviewPagingAndLegacyConflict(t *testing.T) {
	s, db, raw, _ := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected upstream") })
	before := seedProbeMetadata(t, db)
	body := probeReviewBody(t, before)
	first := probeImportReviewRequest(s, "POST", "/admin/redteam/probe-packs/import-review?limit=1", body, "", "operator")
	revision := probeReviewRevision(t, first)
	var page struct {
		Total   int                              `json:"total_items"`
		Offset  int                              `json:"offset"`
		HasMore bool                             `json:"has_more"`
		Changes []store.RedTeamProbeImportChange `json:"changes"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || !page.HasMore || len(page.Changes) != 1 || page.Changes[0].Kind != "pack" {
		t.Fatal("first review page is incomplete")
	}
	for _, path := range []string{"?offset=1", "?offset=-1", "?offset=20001", "?limit=0", "?limit=101", "?offset=0&offset=1", "?unexpected=1", "?limit=abc", "?bad=%"} {
		result := probeImportReviewRequest(s, "POST", "/admin/redteam/probe-packs/import-review"+path, body, "", "operator")
		if result.Code != 400 {
			t.Errorf("%s status=%d", path, result.Code)
		}
	}
	second := probeImportReviewRequest(s, "POST", "/admin/redteam/probe-packs/import-review?offset=1&limit=1", body, revision, "operator")
	if probeReviewRevision(t, second) != revision {
		t.Fatal("read-only pagination changed revision")
	}
	if err := json.Unmarshal(second.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Offset != 1 || page.HasMore || len(page.Changes) != 1 || page.Changes[0].Kind != "case" {
		t.Fatal("second review page is incomplete")
	}
	// A legacy caller changes state between preview and apply. Neither paging nor
	// reviewed PUT may silently adopt that different before-state.
	legacyBody := strings.Replace(body, "reviewed prompt", "concurrent legacy prompt", 1)
	if result := probeCSVImportResponse(s, legacyBody); result.Code != 200 {
		t.Fatalf("legacy import=%d", result.Code)
	}
	for _, methodPath := range [][2]string{{"POST", "/admin/redteam/probe-packs/import-review?offset=1"}, {"PUT", "/admin/redteam/probe-packs/import"}} {
		result := probeImportReviewRequest(s, methodPath[0], methodPath[1], body, revision, "operator")
		if result.Code != 409 {
			t.Errorf("stale %s status=%d", methodPath[0], result.Code)
		}
	}
	assertProbeMetadata(t, before, probeMetadataPack(t, db, before.ID), "concurrent legacy prompt")
	if csvImportAuditCount(t, raw) != 1 {
		t.Fatal("stale review produced extra mutation audit")
	}
}

func TestRedTeamProbeCSVReviewRejectsInvalidRequests(t *testing.T) {
	s, db, raw, _ := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected upstream") })
	body := probeReviewBody(t, seedProbeMetadata(t, db))
	for _, values := range [][]string{{"*"}, {"unquoted"}, {"W/\"" + strings.Repeat("a", 64) + "\""}, {"\"" + strings.Repeat("A", 64) + "\""}, {"\"" + strings.Repeat("a", 64) + "\"", "\"" + strings.Repeat("a", 64) + "\""}, {"\"" + strings.Repeat("a", 64) + "\", \"" + strings.Repeat("b", 64) + "\""}} {
		r := httptest.NewRequest("PUT", "/admin/redteam/probe-packs/import", strings.NewReader(body))
		r.Header.Set("Content-Type", "text/csv")
		for _, v := range values {
			r.Header.Add("If-Match", v)
		}
		result := httptest.NewRecorder()
		s.Routes().ServeHTTP(result, r)
		if result.Code != 400 {
			t.Errorf("invalid revision status=%d", result.Code)
		}
	}
	for _, tc := range []struct {
		name, body, contentType string
		status                  int
	}{
		{"no-content-type", body, "", 400},
		{"json-content-type", body, "application/json", 400},
		{"invalid-utf8", body + "\xff", "text/csv", 400},
		{"nul", strings.Replace(body, "reviewed prompt", "bad\x00prompt", 1), "text/csv", 400},
		{"all-skipped", strings.Replace(body, "reviewed prompt", "", 1), "text/csv", 400},
		{"too-large", strings.Repeat("a", int(redTeamProbeCSVMaxBytes)+1), "text/csv", 413},
		{"too-many-rows", "case_key,input_template\n" + strings.Repeat("key,prompt\n", store.RedTeamProbeReviewMaxRows+1), "text/csv", 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/admin/redteam/probe-packs/import-review", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", tc.contentType)
			result := httptest.NewRecorder()
			s.Routes().ServeHTTP(result, r)
			if result.Code != tc.status {
				t.Errorf("status=%d want=%d", result.Code, tc.status)
			}
		})
	}
	if csvImportAuditCount(t, raw) != 0 {
		t.Fatal("invalid input mutated catalogue")
	}
}

func TestRedTeamProbeCSVReviewPermissionsAndSessionBinding(t *testing.T) {
	s, db, raw, _ := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected upstream") })
	body := probeReviewBody(t, seedProbeMetadata(t, db))
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-synthetic-probe-review-fixture"
	now := time.Now().UTC()
	for _, session := range []string{"csv-session", "another-session"} {
		if err := db.InsertAuthSession(t.Context(), session, "csv-user", "127.0.0.1", "fixture", now.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	claims := accessClaims{Subject: "csv-user", Role: "admin", TeamID: "team-a", Scopes: []string{"admin:write", "admin:read"}, SessionID: "csv-session", Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()}
	token := func(c accessClaims) string {
		v, err := s.signAccessToken(c)
		if err != nil {
			t.Fatal("cannot sign fixture token")
		}
		return v
	}
	original := token(claims)
	revision := probeReviewRevision(t, probeImportReviewRequest(s, "POST", "/admin/redteam/probe-packs/import-review", body, "", original))
	for _, tc := range []struct {
		name   string
		mutate func(*accessClaims)
		status int
	}{
		{"write-only", func(c *accessClaims) { c.Scopes = []string{"admin:write"} }, 403},
		{"read-only", func(c *accessClaims) { c.Scopes = []string{"admin:read"} }, 401},
		{"other-session", func(c *accessClaims) { c.SessionID = "another-session" }, 409},
		{"other-team", func(c *accessClaims) { c.TeamID = "team-b" }, 409},
		{"other-subject", func(c *accessClaims) { c.Subject = "other-user" }, 409},
		{"other-role", func(c *accessClaims) { c.Role = "super_admin" }, 409},
		{"changed-scopes", func(c *accessClaims) { c.Scopes = []string{"admin:read", "admin:write", "security:read"} }, 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changed := claims
			tc.mutate(&changed)
			for _, path := range []string{"/admin/redteam/probe-packs/import-review", "/admin/redteam/probe-packs/import"} {
				method := "PUT"
				if strings.HasSuffix(path, "review") {
					method = "POST"
				}
				result := probeImportReviewRequest(s, method, path, body, revision, token(changed))
				if result.Code != tc.status {
					t.Errorf("status=%d want=%d", result.Code, tc.status)
				}
				if strings.Contains(result.Body.String(), "original prompt") {
					t.Fatal("unauthorized before-content disclosure")
				}
			}
		})
	}
	if csvImportAuditCount(t, raw) != 0 {
		t.Fatal("rejected auth/session mutated catalogue")
	}
	// Refresh and scope order do not change identity when effective session,
	// subject, team, role and scope set are the same.
	refreshed := claims
	refreshed.IssuedAt++
	refreshed.ExpiresAt++
	refreshed.Scopes = []string{"admin:read", "admin:write"}
	result := probeImportReviewRequest(s, "PUT", "/admin/redteam/probe-packs/import", body, revision, token(refreshed))
	if result.Code != 200 || csvImportAuditCount(t, raw) != 1 {
		t.Fatalf("same-session refresh status=%d", result.Code)
	}
}

func TestRedTeamProbeCSVReviewAtomicFailures(t *testing.T) {
	for _, stage := range []string{"pack-error", "case-error", "audit-error", "pack-ignore", "case-ignore", "audit-ignore"} {
		t.Run(stage, func(t *testing.T) {
			s, db, raw, _ := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected upstream") })
			before := seedProbeMetadata(t, db)
			row := probeCSVPublicRow("public-edited", "reviewed prompt")
			row[0], row[1], row[6] = before.ID, "reviewed pack", "editable"
			next := probeCSVPublicRow("atomic-new-case", "new reviewed prompt")
			next[0] = "atomic-new-pack"
			body := probeCSVRecordsBody(t, [][]string{strings.Split(probeCSVPublicHeader, ","), row, next})
			snapshot, err := db.ListRedTeamProbePacks(t.Context(), true)
			if err != nil {
				t.Fatal(err)
			}
			revision := probeReviewRevision(t, probeImportReviewRequest(s, "POST", "/admin/redteam/probe-packs/import-review", body, "", "operator"))
			cleanup := csvImportFault(t, raw, stage)
			result := probeImportReviewRequest(s, "PUT", "/admin/redteam/probe-packs/import", body, revision, "operator")
			if result.Code != 500 || strings.Contains(result.Body.String(), "synthetic-import-database-detail") {
				t.Errorf("fault was acknowledged or detail leaked: status=%d", result.Code)
			}
			after, err := db.ListRedTeamProbePacks(t.Context(), true)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(snapshot, after) || csvImportAuditCount(t, raw) != 0 {
				t.Fatal("failed reviewed import left changes")
			}
			cleanup()
			result = probeImportReviewRequest(s, "PUT", "/admin/redteam/probe-packs/import", body, revision, "operator")
			if result.Code != 200 || csvImportAuditCount(t, raw) != 1 {
				t.Fatalf("explicit retry status=%d", result.Code)
			}
		})
	}
}

func TestRedTeamProbeCSVReviewFinalDuplicateValuesAndExactFileBytes(t *testing.T) {
	s, _, raw, _ := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected upstream") })
	first := probeCSVPublicRow("repeated", "first input")
	last := probeCSVPublicRow("repeated", "last input")
	last[1] = "ignored pack name"
	body := probeCSVRecordsBody(t, [][]string{strings.Split(probeCSVPublicHeader, ","), first, last})
	review := probeImportReviewRequest(s, "POST", "/admin/redteam/probe-packs/import-review", body, "", "operator")
	revision := probeReviewRevision(t, review)
	if strings.Contains(review.Body.String(), "first input") || strings.Contains(review.Body.String(), "ignored pack name") || !strings.Contains(review.Body.String(), "last input") {
		t.Fatal("review did not match final duplicate semantics")
	}
	for _, changed := range []string{strings.TrimPrefix(body, "\ufeff"), strings.ReplaceAll(body, "\n", "\r\n")} {
		result := probeImportReviewRequest(s, "PUT", "/admin/redteam/probe-packs/import", changed, revision, "operator")
		if result.Code != 409 {
			t.Fatalf("different CSV bytes accepted status=%d", result.Code)
		}
	}
	if csvImportAuditCount(t, raw) != 0 {
		t.Fatal("different byte identity applied")
	}
	// Header plus exactly 10000 rows is permitted; the review deduplicates final
	// entities while the receipt still counts source rows.
	rows := "case_key,input_template\n" + strings.Repeat("key,prompt\n", store.RedTeamProbeReviewMaxRows)
	result := probeImportReviewRequest(s, "POST", "/admin/redteam/probe-packs/import-review", rows, "", "operator")
	if result.Code != 200 || !strings.Contains(result.Body.String(), fmt.Sprintf("\"imported_cases\":%d", store.RedTeamProbeReviewMaxRows)) {
		t.Fatalf("exact row boundary status=%d", result.Code)
	}
}

func TestRedTeamProbeCSVReviewStoredAndResponseBounds(t *testing.T) {
	for _, tc := range []struct {
		name    string
		content string
	}{
		{"stored-snapshot", strings.Repeat("x", int(store.RedTeamProbeReviewMaxSnapshotBytes)+1)},
		{"encoded-response", strings.Repeat("<", 6<<20)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db, raw, _ := reviewedRecordingFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected upstream") })
			before := seedProbeMetadata(t, db)
			c := before.Cases[0]
			for _, existing := range before.Cases {
				if existing.ID == "public-edited" {
					c = existing
				}
			}
			c.InputTemplate = tc.content
			if err := db.UpsertRedTeamProbeCase(t.Context(), c); err != nil {
				t.Fatal(err)
			}
			result := probeImportReviewRequest(s, "POST", "/admin/redteam/probe-packs/import-review", probeReviewBody(t, before), "", "operator")
			if result.Code != 413 || !strings.Contains(result.Body.String(), "redteam_import_review_limit") {
				t.Fatalf("bounded review status=%d", result.Code)
			}
			if result.Header().Get("ETag") != "" || csvImportAuditCount(t, raw) != 0 {
				t.Fatal("oversized review exposed usable revision or mutated")
			}
		})
	}
}

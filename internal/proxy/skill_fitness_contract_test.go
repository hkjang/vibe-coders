package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// These pin the existing authenticated HTTP/storage contract, including its
// permissive defaults and append semantics. They are not browser evidence or a
// new validation, reference-verification, deduplication or promotion policy.
func TestSkillFitnessContractDefaultsAndLegacyCreatedTimestamp(t *testing.T) {
	f := newSkillFitnessContractFixture(t)
	const name = "unknown-fitness-skill"
	empty := f.list(t, " \t"+name+"\n", f.reader)
	if empty.Skill != name || len(empty.Evidence) != 0 || empty.Passing != 0 || empty.Required != 2 {
		t.Fatal("unknown skill must remain a confirmed empty list, not a missing-skill error")
	}
	for _, body := range []string{
		`{"skill":" unknown-fitness-skill "}`,
		`{"skill":"unknown-fitness-skill","kind":null,"ref_id":null,"passed":null,"score":null,"note":null}`,
		`{"skill":"unknown-fitness-skill","kind":"unknown","ignored":"legacy field"}`,
	} {
		saved := f.append(t, body)
		if saved.SkillName != name || saved.Kind != "multimodel" || saved.RefID != "" || saved.Passed || saved.Score != 0 || saved.Note != "" {
			t.Fatal("existing omitted/null/default semantics changed")
		}
		if saved.CreatedAt != "" {
			t.Fatal("legacy 201 returns an empty timestamp, not the store's internally generated time")
		}
		rows, err := f.db.ListSkillFitnessEvidence(t.Context(), name)
		index := slices.IndexFunc(rows, func(row store.SkillFitnessEvidence) bool { return row.ID == saved.ID })
		if err != nil || index < 0 {
			t.Fatal("successful append did not persist its returned ID")
		}
		if at, err := time.Parse(time.RFC3339Nano, rows[index].CreatedAt); err != nil || at.IsZero() {
			t.Fatal("stored timestamp must be valid and nonzero independently of the legacy 201 response")
		}
		rows[index].CreatedAt = ""
		if !reflect.DeepEqual(rows[index], saved) {
			t.Fatal("stored evidence changed another returned field")
		}
	}
	if _, found, err := f.db.GetSkill(t.Context(), name); err != nil || found {
		t.Fatal("fitness append must not silently create or require a skill definition")
	}
	if got := f.list(t, name, f.reader); len(got.Evidence) != 3 || got.Passing != 0 {
		t.Fatal("default nonpassing appends must remain distinct stored rows")
	}
}

func TestSkillFitnessContractKindsDecimalsRawReadAndAuditIdentity(t *testing.T) {
	f := newSkillFitnessContractFixture(t)
	const name = "한글 근거 / + ? & #"
	for i, kind := range []string{"multimodel", "golden", "testcase"} {
		body, _ := json.Marshal(map[string]any{
			"skill": name, "kind": " " + kind + " ", "ref_id": " ref@synthetic.example ",
			"passed": i != 1, "score": []float64{-1.25, 0, 0.000000000125}[i], "note": " note@synthetic.example ",
		})
		got := f.append(t, string(body))
		if got.Kind != kind || got.RefID != "ref@synthetic.example" || got.Note != "note@synthetic.example" || got.Score != []float64{-1.25, 0, 0.000000000125}[i] || got.CreatedBy != "fitness-writer" {
			t.Fatal("known kind, finite decimal or existing subject authorship changed")
		}
	}
	// Raw-prompt role restrictions do not apply to this existing admin endpoint.
	got := f.list(t, name, f.reader)
	if got.Passing != 2 || len(got.Evidence) != 3 {
		t.Fatal("passing count does not match append records")
	}
	for _, row := range got.Evidence {
		if row.Note != "note@synthetic.example" || row.RefID != "ref@synthetic.example" || row.CreatedBy != "fitness-writer" {
			t.Fatal("existing admin-read evidence fields must not gain an invented raw-prompt permission boundary")
		}
	}
	events := f.audits(t)
	if len(events) != 3 {
		t.Fatal("each append must emit its existing best-effort admin audit")
	}
	for _, event := range events {
		var after map[string]any
		if event.Action != "skill.fitness_evidence" || event.BeforeValue != name || event.AdminID != "admin_"+hashProxyKey(f.writer)[:12] || json.Unmarshal([]byte(event.AfterValue), &after) != nil || len(after) != 3 || after["ref"] != "ref@synthetic.example" {
			t.Fatal("audit must retain hash actor, skill target and only kind/passed/ref payload")
		}
		if _, ok := after["passed"].(bool); !ok || !slices.Contains([]any{"multimodel", "golden", "testcase"}, after["kind"]) {
			t.Fatal("audit kind/passed fields changed")
		}
	}
}

func TestSkillFitnessContractInvalidAndUnauthorizedRequestsDoNotAppend(t *testing.T) {
	f := newSkillFitnessContractFixture(t)
	const path = "/admin/skills/fitness"
	for _, body := range []string{
		`null`, `{}`, `{"skill":null}`, `{"skill":" \t"}`, `[]`, `{"skill":`,
		`{"skill":"skill","kind":1}`, `{"skill":"skill","passed":"true"}`,
		`{"skill":"skill","score":"1"}`, `{"skill":"skill","score":1e309}`,
		`{"skill":"skill","ref_id":[]}`, `{"skill":"skill","note":{}}`,
	} {
		f.request(t, http.MethodPost, path, f.writer, body, http.StatusBadRequest)
	}
	for _, query := range []string{"", "?skill=%20"} {
		f.request(t, http.MethodGet, path+query, f.reader, "", http.StatusBadRequest)
	}
	for _, token := range []string{"", f.unprivileged} {
		f.request(t, http.MethodGet, path+"?skill=skill", token, "", http.StatusUnauthorized)
		f.request(t, http.MethodPost, path, token, `{"skill":"skill","passed":true}`, http.StatusUnauthorized)
	}
	f.request(t, http.MethodPost, path, f.reader, `{"skill":"skill","passed":true}`, http.StatusUnauthorized)
	for _, method := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete} {
		f.request(t, method, path, f.writer, `{"skill":"skill"}`, http.StatusMethodNotAllowed)
	}
	if got := f.list(t, "skill", f.reader); len(got.Evidence) != 0 || got.Passing != 0 || len(f.audits(t)) != 0 {
		t.Fatal("invalid/denied requests changed fitness records, count or admin audit")
	}
}

func TestSkillFitnessContractDuplicateReferencesCountTowardExistingGate(t *testing.T) {
	f := newSkillFitnessContractFixture(t)
	const name = "fitness-gated-skill"
	seed := store.Skill{Name: name, Version: "v1", Status: "staging", RiskLevel: "high", Instructions: "Review the supplied changes.", AllowedModels: "test-model", AllowedTools: "read", AllowedTeams: "test-team", DailyLimit: 10}
	if _, err := f.db.UpsertSkill(t.Context(), seed, "seed-actor"); err != nil {
		t.Fatal(err)
	}
	promote := `{"name":"fitness-gated-skill","to_status":"production","note":"reviewed synthetic fixture"}`
	first := ""
	for count := 0; count < 2; count++ {
		data := f.request(t, http.MethodPost, "/admin/skills/promote", f.writer, promote, http.StatusUnprocessableEntity)
		var gate struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
			Passing  int `json:"passing_count"`
			Required int `json:"required_count"`
		}
		if json.Unmarshal(data, &gate) != nil || gate.Error.Code != "model_fitness_gate" || gate.Passing != count || gate.Required != 2 {
			t.Fatal("fixture must reach the real model-fitness gate, not a different promotion rejection")
		}
		saved := f.append(t, `{"skill":"fitness-gated-skill","kind":"golden","ref_id":"unverified-same-reference","passed":true}`)
		if saved.ID == first {
			t.Fatal("same reference append unexpectedly deduplicated the record")
		}
		first = saved.ID
		if got := f.list(t, name, f.reader); got.Passing != count+1 || len(got.Evidence) != count+1 {
			t.Fatal("duplicate references must retain the current append/count behavior")
		}
	}
	before, found, err := f.db.GetSkill(t.Context(), name)
	if err != nil || !found || before.Status != "staging" {
		t.Fatal("recording evidence must not itself promote the skill")
	}
	f.request(t, http.MethodPost, "/admin/skills/promote", f.writer, promote, http.StatusOK)
	after, found, err := f.db.GetSkill(t.Context(), name)
	if err != nil || !found || after.Status != "production" {
		t.Fatal("two appended passing rows must satisfy the existing gate on an explicit promotion")
	}
}

func TestSkillFitnessContractExistingNameTrimAndOpaqueUnicode(t *testing.T) {
	f := newSkillFitnessContractFixture(t)
	for _, name := range []string{"skill", "\ufeffskill", "한글\ufeff\u0085내부"} {
		body, _ := json.Marshal(map[string]any{"skill": name, "ref_id": name, "passed": true})
		got := f.append(t, string(body))
		if got.SkillName != name || got.RefID != name {
			t.Fatal("existing exact Unicode names must not be normalized by this contract test")
		}
		read := f.list(t, name, f.reader)
		if read.Skill != name || len(read.Evidence) != 1 || read.Evidence[0].RefID != name {
			t.Fatal("GET must preserve the exact non-trimmed Unicode target")
		}
	}
	for _, name := range []string{" skill ", "\u0085skill", "skill\u0085"} {
		read := f.list(t, name, f.reader)
		if read.Skill != "skill" || len(read.Evidence) == 0 {
			t.Fatal("GET must retain Go TrimSpace's current edge-whitespace behavior")
		}
		body, _ := json.Marshal(map[string]any{"skill": name, "ref_id": name})
		if saved := f.append(t, string(body)); saved.SkillName != "skill" || saved.RefID != "skill" {
			t.Fatal("POST must retain Go TrimSpace's existing target/ref behavior")
		}
	}
	if got := f.list(t, "skill", f.reader); len(got.Evidence) != 4 || got.Passing != 1 {
		t.Fatal("normalized legacy appends must target the canonical skill, without changing the separate FEFF name")
	}
}

type skillFitnessContractList struct {
	Skill    string                       `json:"skill"`
	Evidence []store.SkillFitnessEvidence `json:"evidence"`
	Passing  int                          `json:"passing_count"`
	Required int                          `json:"required"`
}

type skillFitnessContractFixture struct {
	db                           *store.SQLStore
	gateway                      *httptest.Server
	writer, reader, unprivileged string
}

func newSkillFitnessContractFixture(t *testing.T) *skillFitnessContractFixture {
	t.Helper()
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(func() {
		if hits.Load() != 0 {
			t.Error("fitness recording/listing/promotion must not execute a model request")
		}
	})
	gateway, server, db := scopedSettingsSecurityServer(t, upstream.URL)
	now := time.Now().UTC()
	return &skillFitnessContractFixture{
		db: db, gateway: gateway,
		writer:       issueLLMScopedTestToken(t, db, server, "fitness-writer", "fitness_operator", "", []string{"admin:read", "admin:write"}, now),
		reader:       issueLLMScopedTestToken(t, db, server, "fitness-reader", "readonly_admin", "", []string{"admin:read"}, now),
		unprivileged: issueLLMScopedTestToken(t, db, server, "fitness-unprivileged", "developer", "", []string{"chat:completion"}, now),
	}
}

func (f *skillFitnessContractFixture) request(t *testing.T, method, path, token, body string, status int) []byte {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), method, f.gateway.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Vibe-UI", "app")
	response, err := f.gateway.Client().Do(r)
	if err != nil {
		t.Fatal("fitness HTTP request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != status {
		t.Fatalf("fitness %s returned %d, want %d", method, response.StatusCode, status)
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal("fitness response read failed")
	}
	return data
}

func (f *skillFitnessContractFixture) append(t *testing.T, body string) store.SkillFitnessEvidence {
	t.Helper()
	data := f.request(t, http.MethodPost, "/admin/skills/fitness", f.writer, body, http.StatusCreated)
	var got store.SkillFitnessEvidence
	var wire map[string]json.RawMessage
	if json.Unmarshal(data, &got) != nil || json.Unmarshal(data, &wire) != nil || got.ID == "" || len(wire) != 9 {
		t.Fatal("append must return the existing flat nine-field evidence row")
	}
	return got
}

func (f *skillFitnessContractFixture) list(t *testing.T, name, token string) skillFitnessContractList {
	t.Helper()
	data := f.request(t, http.MethodGet, "/admin/skills/fitness?skill="+url.QueryEscape(name), token, "", http.StatusOK)
	var got skillFitnessContractList
	var wire map[string]json.RawMessage
	if json.Unmarshal(data, &got) != nil || json.Unmarshal(data, &wire) != nil || got.Evidence == nil || len(wire) != 4 {
		t.Fatal("GET must return confirmed skill/evidence/count/threshold fields")
	}
	return got
}

func (f *skillFitnessContractFixture) audits(t *testing.T) []store.AdminAuditPublic {
	t.Helper()
	events, err := f.db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal(err)
	}
	return events
}

package store

import (
	"context"
	"testing"
	"time"
)

func TestText2SQLRiskMiningAndAnomalyQueriesHonorTeamScope(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()

	ctx := context.Background()
	for _, key := range []APIKeyRecord{
		{ID: "t2s_alpha_1", Name: "alpha one", Team: "alpha", KeyHash: "t2s-alpha-hash-1", Status: "active"},
		{ID: "t2s_alpha_2", Name: "alpha two", Team: "alpha", KeyHash: "t2s-alpha-hash-2", Status: "active"},
		{ID: "t2s_beta_1", Name: "beta one", Team: "beta", KeyHash: "t2s-beta-hash-1", Status: "active"},
	} {
		if err := db.UpsertAPIKey(ctx, key); err != nil {
			t.Fatal(err)
		}
	}

	base := time.Now().UTC().Add(-time.Hour)
	add := func(id, apiKeyID, team, question string, valid bool, offset int) {
		t.Helper()
		insertScopedText2SQLFixture(t, db, Text2SQLQueryLog{
			ID: id, APIKeyID: apiKeyID, Team: team, Question: question,
			GeneratedSQL: "SELECT department, count(*) FROM tickets GROUP BY department",
			Valid:        valid, Executed: valid, CostKRW: 10, CreatedAt: base.Add(time.Duration(offset) * time.Minute),
		})
	}

	// Alpha has one benign request followed by recurring analytics and permission probes.
	add("alpha-benign", "t2s_alpha_1", "alpha", "alpha normal lookup", true, 1)
	add("alpha-report-1", "t2s_alpha_1", "alpha", "alphamarker recurring report", true, 2)
	add("alpha-report-2", "t2s_alpha_2", "alpha", "alphamarker recurring report", true, 3)
	add("alpha-report-3", "t2s_alpha_1", "alpha", "alphamarker recurring report", true, 4)
	for i, id := range []string{"alpha-probe-1", "alpha-probe-2"} {
		log := Text2SQLQueryLog{
			ID: id, APIKeyID: "t2s_alpha_1", Team: "alpha", Question: "restricted payroll table",
			Valid: false, RejectReason: "table not allowed", FailureCategory: "permission_denied",
			ExplainRisk: 90, CreatedAt: base.Add(time.Duration(5+i) * time.Minute),
		}
		insertScopedText2SQLFixture(t, db, log)
	}

	// Beta has enough independent activity to produce every derived result if it leaks.
	add("beta-report-1", "t2s_beta_1", "beta", "betamarker recurring report", true, 10)
	add("beta-report-2", "t2s_beta_1", "beta", "betamarker recurring report", true, 11)
	add("beta-report-3", "t2s_beta_1", "beta", "betamarker recurring report", true, 12)
	insertScopedText2SQLFixture(t, db, Text2SQLQueryLog{
		ID: "beta-risk", APIKeyID: "t2s_beta_1", Team: "beta", Question: "all tables in beta",
		Valid: false, FailureCategory: "permission_denied", ExplainRisk: 95, CreatedAt: base.Add(13 * time.Minute),
	})

	// A derived record without a request-log anchor remains visible to legacy full-admin
	// queries, but must fail closed for every team-scoped query.
	if err := db.InsertText2SQLLog(ctx, Text2SQLQueryLog{
		ID: "orphan-risk", APIKeyID: "orphan-key", Team: "alpha", Question: "orphanmarker recurring report",
		Valid: false, ExplainRisk: 99, CreatedAt: base.Add(14 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}

	since := base.Add(-time.Minute)
	alphaTeams := []string{" alpha ", "", "alpha"}

	t.Run("risk queue", func(t *testing.T) {
		legacy, err := db.RiskyText2SQLLogs(ctx, since, 70, 100)
		if err != nil {
			t.Fatal(err)
		}
		if !text2SQLLogsContainID(legacy, "beta-risk") || !text2SQLLogsContainID(legacy, "orphan-risk") {
			t.Fatalf("legacy risk queue lost unrestricted rows: %+v", legacy)
		}

		logs, err := db.RiskyText2SQLLogsScoped(ctx, since, 70, 100, alphaTeams, true)
		if err != nil {
			t.Fatal(err)
		}
		if !text2SQLLogsContainID(logs, "alpha-probe-1") || !text2SQLLogsContainID(logs, "alpha-probe-2") {
			t.Fatalf("alpha risk rows missing: %+v", logs)
		}
		for _, denied := range []string{"beta-risk", "orphan-risk"} {
			if text2SQLLogsContainID(logs, denied) {
				t.Fatalf("%q crossed the request-team boundary: %+v", denied, logs)
			}
		}
	})

	t.Run("miners", func(t *testing.T) {
		legacy, err := db.Text2SQLReportCandidates(ctx, since, 3, 50)
		if err != nil {
			t.Fatal(err)
		}
		if !text2SQLReportsContainQuestion(legacy, "alphamarker recurring report") || !text2SQLReportsContainQuestion(legacy, "betamarker recurring report") {
			t.Fatalf("legacy report candidates lost unrestricted rows: %+v", legacy)
		}

		reports, err := db.Text2SQLReportCandidatesScoped(ctx, since, 3, 50, alphaTeams, true)
		if err != nil {
			t.Fatal(err)
		}
		if !text2SQLReportsContainQuestion(reports, "alphamarker recurring report") || text2SQLReportsContainQuestion(reports, "betamarker recurring report") {
			t.Fatalf("team-scoped report candidates mismatch: %+v", reports)
		}

		terms, err := db.Text2SQLGlossaryCandidatesScoped(ctx, since, 3, 50, alphaTeams, true)
		if err != nil {
			t.Fatal(err)
		}
		if !text2SQLGlossaryContains(terms, "alphamarker") || text2SQLGlossaryContains(terms, "betamarker") || text2SQLGlossaryContains(terms, "orphanmarker") {
			t.Fatalf("team-scoped glossary candidates mismatch: %+v", terms)
		}
	})

	t.Run("prompt DNA", func(t *testing.T) {
		dna, err := db.Text2SQLPromptDNAReportScoped(ctx, since, 3, 50, alphaTeams, true)
		if err != nil {
			t.Fatal(err)
		}
		entry, ok := text2SQLDNAByQuestion(dna, "alphamarker recurring report")
		if !ok || entry.Count != 3 || entry.DistinctUser != 2 {
			t.Fatalf("alpha prompt DNA mismatch: %+v", dna)
		}
		if _, leaked := text2SQLDNAByQuestion(dna, "betamarker recurring report"); leaked {
			t.Fatalf("beta prompt DNA crossed team boundary: %+v", dna)
		}
	})

	t.Run("anomaly detectors", func(t *testing.T) {
		smells, err := db.Text2SQLUsageSmellsScoped(ctx, since, 2, 2, alphaTeams, true)
		if err != nil {
			t.Fatal(err)
		}
		if !text2SQLSmellsContainSubject(smells, "t2s_alpha_1") || text2SQLSmellsContainSubject(smells, "t2s_beta_1") {
			t.Fatalf("team-scoped usage smells mismatch: %+v", smells)
		}

		exposure, err := db.Text2SQLRiskExposureByTeamScoped(ctx, since, alphaTeams, true)
		if err != nil {
			t.Fatal(err)
		}
		if len(exposure) != 1 || exposure[0].Team != "alpha" || exposure[0].Rejected != 2 {
			t.Fatalf("team-scoped risk exposure mismatch: %+v", exposure)
		}

		drifts, err := db.Text2SQLIntentDriftsScoped(ctx, since, alphaTeams, true)
		if err != nil {
			t.Fatal(err)
		}
		if !text2SQLDriftsContainSubject(drifts, "t2s_alpha_1") || text2SQLDriftsContainSubject(drifts, "t2s_beta_1") {
			t.Fatalf("team-scoped intent drifts mismatch: %+v", drifts)
		}
	})

	t.Run("empty scope fails closed", func(t *testing.T) {
		assertEmptyText2SQLScopedResults(t, db, ctx, since, nil)
		assertEmptyText2SQLScopedResults(t, db, ctx, since, []string{"", "   "})
	})
}

func insertScopedText2SQLFixture(t *testing.T, db *SQLStore, log Text2SQLQueryLog) {
	t.Helper()
	requestID := "request-" + log.ID
	if err := db.InsertLogRecord(context.Background(), LogRecord{Request: RequestLog{
		ID: requestID, TraceID: requestID, APIKeyID: log.APIKeyID,
		Endpoint: "/v1/text2sql", Model: "text2sql", Provider: "fixture",
		StatusCode: 200, CreatedAt: log.CreatedAt,
	}}); err != nil {
		t.Fatal(err)
	}
	log.RequestID = requestID
	if err := db.InsertText2SQLLog(context.Background(), log); err != nil {
		t.Fatal(err)
	}
}

func assertEmptyText2SQLScopedResults(t *testing.T, db *SQLStore, ctx context.Context, since time.Time, teams []string) {
	t.Helper()
	if got, err := db.RiskyText2SQLLogsScoped(ctx, since, 70, 100, teams, true); err != nil || len(got) != 0 {
		t.Fatalf("empty scoped risk queue = %+v, err=%v", got, err)
	}
	if got, err := db.Text2SQLReportCandidatesScoped(ctx, since, 2, 50, teams, true); err != nil || len(got) != 0 {
		t.Fatalf("empty scoped report candidates = %+v, err=%v", got, err)
	}
	if got, err := db.Text2SQLGlossaryCandidatesScoped(ctx, since, 2, 50, teams, true); err != nil || len(got) != 0 {
		t.Fatalf("empty scoped glossary candidates = %+v, err=%v", got, err)
	}
	if got, err := db.Text2SQLPromptDNAReportScoped(ctx, since, 2, 50, teams, true); err != nil || len(got) != 0 {
		t.Fatalf("empty scoped prompt DNA = %+v, err=%v", got, err)
	}
	if got, err := db.Text2SQLUsageSmellsScoped(ctx, since, 2, 2, teams, true); err != nil || len(got) != 0 {
		t.Fatalf("empty scoped usage smells = %+v, err=%v", got, err)
	}
	if got, err := db.Text2SQLRiskExposureByTeamScoped(ctx, since, teams, true); err != nil || len(got) != 0 {
		t.Fatalf("empty scoped risk exposure = %+v, err=%v", got, err)
	}
	if got, err := db.Text2SQLIntentDriftsScoped(ctx, since, teams, true); err != nil || len(got) != 0 {
		t.Fatalf("empty scoped intent drifts = %+v, err=%v", got, err)
	}
}

func text2SQLLogsContainID(logs []Text2SQLQueryLog, id string) bool {
	for _, log := range logs {
		if log.ID == id {
			return true
		}
	}
	return false
}

func text2SQLReportsContainQuestion(reports []Text2SQLReportCandidate, question string) bool {
	for _, report := range reports {
		if report.Question == question {
			return true
		}
	}
	return false
}

func text2SQLGlossaryContains(terms []Text2SQLGlossaryCandidate, term string) bool {
	for _, candidate := range terms {
		if candidate.Term == term {
			return true
		}
	}
	return false
}

func text2SQLDNAByQuestion(items []Text2SQLPromptDNA, question string) (Text2SQLPromptDNA, bool) {
	for _, item := range items {
		if item.Question == question {
			return item, true
		}
	}
	return Text2SQLPromptDNA{}, false
}

func text2SQLSmellsContainSubject(items []Text2SQLUsageSmell, subject string) bool {
	for _, item := range items {
		if item.Subject == subject {
			return true
		}
	}
	return false
}

func text2SQLDriftsContainSubject(items []Text2SQLIntentDrift, subject string) bool {
	for _, item := range items {
		if item.Subject == subject {
			return true
		}
	}
	return false
}

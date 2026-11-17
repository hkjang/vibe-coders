package proxy

import (
	"net/http"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func TestRedTeamCampaignReviewTracksRunningAndFinishedRuns(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	s, db, c := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		redTeamAdmissionReply(w)
	})
	review := issueReviewed(t, s, c, reviewedBody())
	done := make(chan int, 1)
	go func() { done <- reviewedRequest(s, c, executionBody(review), "operator", true).Code }()
	defer func() {
		close(release)
		select {
		case code := <-done:
			if code != 200 {
				t.Errorf("execution status %d", code)
			}
		case <-time.After(10 * time.Second):
			t.Error("execution did not settle")
		}
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("provider was not called")
	}
	query := store.RedTeamRunQuery{Limit: 25, CampaignID: c.ID, ReviewID: review.ReviewID, Kind: "campaign"}
	runs, total, err := db.RedTeamRunPage(t.Context(), query)
	if err != nil || total != 1 || len(runs) != 1 {
		t.Fatalf("running review cannot be found: count %d, rows %d, err %v", total, len(runs), err)
	}
	if runs[0].Status != "running" || runs[0].ReviewID != review.ReviewID || runs[0].SourceResultID != "" {
		t.Fatalf("incorrect campaign review metadata: %+v", runs[0])
	}
}

func TestRedTeamCampaignReviewHistorySeparatesCompletedExecutions(t *testing.T) {
	s, db, c := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) { redTeamAdmissionReply(w) })
	for _, kind := range []string{"live", "simulation"} {
		body := reviewedBody()
		body.Kind = kind
		review := issueReviewed(t, s, c, body)
		execution := executionBody(review)
		if kind == "simulation" {
			delete(execution, "proxy_key")
		}
		w := reviewedRequest(s, c, execution, "operator", true)
		if w.Code != 200 {
			t.Fatalf("execution %s: %d %s", kind, w.Code, w.Body.String())
		}
		query := store.RedTeamRunQuery{Limit: 25, CampaignID: c.ID, ReviewID: review.ReviewID, Kind: "campaign"}
		runs, total, err := db.RedTeamRunPage(t.Context(), query)
		if err != nil || total != 1 || len(runs) != 1 {
			t.Fatalf("finished review cannot be found: count %d, rows %d, err %v", total, len(runs), err)
		}
		if runs[0].Status == "running" || runs[0].ReviewID != review.ReviewID || runs[0].SourceResultID != "" {
			t.Fatalf("incorrect finished metadata: %+v", runs[0])
		}
		query.Kind = "replay"
		_, total, err = db.RedTeamRunPage(t.Context(), query)
		if err != nil || total != 0 {
			t.Fatal("campaign execution classified as a replay")
		}
	}
}

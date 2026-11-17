package proxy

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestRedTeamReviewedRedirectDoesNotDispatchUnreviewedEndpoint(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var targetCalls, otherCalls atomic.Int32
			other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				otherCalls.Add(1)
				redTeamAdmissionReply(w)
			}))
			defer other.Close()
			s, db, campaign := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) {
				targetCalls.Add(1)
				http.Redirect(w, r, other.URL+"/v1/chat/completions", status)
			})
			review := issueReviewed(t, s, campaign, reviewedBody())
			w := reviewedRequest(s, campaign, executionBody(review), "operator", true)
			if w.Code != 200 || targetCalls.Load() != 1 || otherCalls.Load() != 0 {
				t.Fatalf("review dispatched unreviewed endpoint: status=%d reviewed=%d other=%d", w.Code, targetCalls.Load(), otherCalls.Load())
			}
			results, err := db.ListRedTeamCaseResults(t.Context(), "")
			if err != nil || len(results) != 1 || results[0].Decision != "error" {
				t.Fatal("redirect treated as a completed model verdict")
			}
			legacy := s.redTeamActiveInvoke(httptest.NewRequest(http.MethodPost, "/", nil), "synthetic-key", "test-model", "test", "Public synthetic", "legacy", 77)
			if legacy.Code != 200 || targetCalls.Load() != 2 || otherCalls.Load() != 1 {
				t.Fatal("legacy redirect behavior changed")
			}
		})
	}
}

package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestAdminTeamPageUnicodeAndTimeOrder(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	base := time.Date(2026, 11, 12, 2, 0, 0, 0, time.UTC)
	deltas := []time.Duration{0, time.Nanosecond, 100 * time.Millisecond}
	for index, delta := range deltas {
		if err := db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: fmt.Sprintf("team-unicode-http-%d", index), Name: fmt.Sprintf("Équipe %d %%_!", index),
			CreatedAt: base.Add(delta), UpdatedAt: base.Add(deltas[len(deltas)-1-index])}); err != nil {
			t.Fatal(err)
		}
	}
	for _, field := range []string{"created_at", "updated_at"} {
		for _, direction := range []string{"asc", "desc"} {
			for offset := range deltas {
				query := url.Values{"view": {"registered"}, "q": {"éQUIPE"}, "sort": {field + ":" + direction}, "limit": {"1"}, "offset": {fmt.Sprint(offset)}}
				response, err := http.Get(gateway.URL + "/admin/teams?" + query.Encode())
				if err != nil {
					t.Fatal(err)
				}
				var page store.AuthTeamPage
				err = json.NewDecoder(response.Body).Decode(&page)
				response.Body.Close()
				index := offset
				if (direction == "desc") != (field == "updated_at") {
					index = len(deltas) - 1 - offset
				}
				if err != nil || response.StatusCode != 200 || response.Header.Get("Cache-Control") != "no-store" ||
					page.Total != 3 || len(page.Teams) != 1 || page.Teams[0].ID != fmt.Sprintf("team-unicode-http-%d", index) ||
					!page.Teams[0].CreatedAt.Equal(base.Add(deltas[index])) || !page.Teams[0].UpdatedAt.Equal(base.Add(deltas[len(deltas)-1-index])) {
					t.Fatalf("team HTTP Unicode/time page mismatch: sort=%s:%s offset=%d err=%v", field, direction, offset, err)
				}
			}
		}
	}
}

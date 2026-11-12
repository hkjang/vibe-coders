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

func TestAdminAccountPageUnicodeAndTimeOrder(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	base := time.Date(2026, 11, 12, 2, 0, 0, 0, time.UTC)
	deltas := []time.Duration{0, time.Nanosecond, 100 * time.Millisecond}
	for index, delta := range deltas {
		id := fmt.Sprintf("unicode-http-%d", index)
		if err := db.CreateAuthUser(t.Context(), store.AuthUser{ID: id, Email: id + "@example.test", Name: "Équipe %_!",
			Role: "developer", Status: "active", PasswordHash: "fixture-unused", CreatedAt: base.Add(delta)}); err != nil {
			t.Fatal(err)
		}
	}
	for offset := range deltas {
		query := url.Values{"view": {"accounts"}, "q": {"éQUIPE %_!"}, "limit": {"1"}, "offset": {fmt.Sprint(offset)}}
		response, err := http.Get(gateway.URL + "/admin/users?" + query.Encode())
		if err != nil {
			t.Fatal(err)
		}
		var page store.AuthAccountPage
		err = json.NewDecoder(response.Body).Decode(&page)
		response.Body.Close()
		index := len(deltas) - 1 - offset
		if err != nil || response.StatusCode != 200 || response.Header.Get("Cache-Control") != "no-store" ||
			page.Total != 3 || len(page.Accounts) != 1 || page.Accounts[0].ID != fmt.Sprintf("unicode-http-%d", index) || !page.Accounts[0].CreatedAt.Equal(base.Add(deltas[index])) {
			t.Fatalf("account HTTP Unicode/time page mismatch: offset=%d err=%v", offset, err)
		}
	}
}

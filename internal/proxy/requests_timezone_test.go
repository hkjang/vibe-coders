package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"testing"
	"time"
)

func TestRequestTimezoneHistoricalCompatibility(t *testing.T) {
	for _, tc := range []struct {
		zone    string
		utcHour int
	}{
		{"Asia/Seoul", 2}, {"asia/seoul", 2}, {" Asia/Seoul ", 2},
		{"", 3}, {"KST", 3}, {"kst", 3}, {"unknown/timezone", 3}, {"utc", 12},
	} {
		t.Run(tc.zone, func(t *testing.T) {
			got := parseRangeBound("1988-07-01T12:00", searchLocation(tc.zone), false)
			want := time.Date(1988, 7, 1, tc.utcHour, 0, 0, 0, time.UTC)
			if !got.Equal(want) {
				t.Fatalf("zone %q: got %s, want %s", tc.zone, got.UTC(), want)
			}
		})
	}
	// Search timezone resolution must not change the existing billing/quota clock.
	if _, offset := time.Date(1988, 7, 1, 12, 0, 0, 0, seoulZone).Zone(); offset != 9*3600 {
		t.Fatalf("quota timezone offset = %d, want fixed UTC+9", offset)
	}
}

func TestRequestTimezoneHandlerParity(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	cases := []struct {
		name, zone, from, to, first, last string
	}{
		{"historical Seoul summer", "Asia/Seoul", "1988-07-01T12:00", "1988-07-01T12:01", "1988-07-01T02:00:00Z", "1988-07-01T02:01:00Z"},
		{"modern Seoul", "Asia/Seoul", "2026-07-01T12:00", "2026-07-01T12:01", "2026-07-01T03:00:00Z", "2026-07-01T03:01:00Z"},
		{"quarter-hour offset", "Asia/Kathmandu", "2026-07-01T12:00", "2026-07-01T12:01", "2026-07-01T06:15:00Z", "2026-07-01T06:16:00Z"},
		{"UTC", "UTC", "2026-07-01T12:00", "2026-07-01T12:01", "2026-07-01T12:00:00Z", "2026-07-01T12:01:00Z"},
		{"spring 23-hour day", "America/New_York", "2026-03-08", "2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T03:59:59.999999999Z"},
		{"autumn 25-hour day", "America/New_York", "2026-11-01", "2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T04:59:59.999999999Z"},
		{"absolute offset takes precedence", "Asia/Seoul", "1988-07-01T12:00:00.123456789+05:45", "1988-07-01T12:00:00.123456790+05:45", "1988-07-01T06:15:00.123456789Z", "1988-07-01T06:15:00.123456790Z"},
	}
	for index, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parse := func(raw string) time.Time {
				t.Helper()
				value, err := time.Parse(time.RFC3339Nano, raw)
				if err != nil {
					t.Fatal(err)
				}
				return value
			}
			first, last := parse(tc.first), parse(tc.last)
			ip := fmt.Sprintf("192.0.2.%d", index+1)
			prefix := fmt.Sprintf("public-zone-%d-", index)
			for _, row := range []struct {
				suffix string
				at     time.Time
			}{
				{"before", first.Add(-time.Nanosecond)}, {"first", first},
				{"last", last}, {"after", last.Add(time.Nanosecond)},
			} {
				insertAppRequestTestRowWithIP(t, db, prefix+row.suffix, "public-provider", http.StatusOK, ip, row.at)
			}
			query := url.Values{"ip": {ip}, "tz": {tc.zone}, "from": {tc.from}, "to": {tc.to}, "limit": {"50"}}
			endpoint := gateway.URL + "/admin/requests?" + query.Encode()
			app := readAppRequestPage(t, providerAppRequest(t, http.MethodGet, endpoint, nil))
			appIDs := make([]string, 0, len(app.Requests))
			for _, row := range app.Requests {
				appIDs = append(appIDs, row.RequestID)
			}
			response, err := http.Get(endpoint)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("Legacy status = %d", response.StatusCode)
			}
			var legacy struct {
				Requests []struct {
					ID string `json:"id"`
				} `json:"requests"`
			}
			if err := json.NewDecoder(response.Body).Decode(&legacy); err != nil {
				t.Fatal(err)
			}
			legacyIDs := make([]string, 0, len(legacy.Requests))
			for _, row := range legacy.Requests {
				legacyIDs = append(legacyIDs, row.ID)
			}
			want := []string{prefix + "last", prefix + "first"}
			if !reflect.DeepEqual(appIDs, want) || !reflect.DeepEqual(legacyIDs, want) {
				t.Fatalf("range %s..%s tz=%s: app=%v legacy=%v want=%v", tc.from, tc.to, tc.zone, appIDs, legacyIDs, want)
			}
		})
	}
}

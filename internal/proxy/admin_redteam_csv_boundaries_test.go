package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func redTeamBoundaryCSV(size int) string {
	header := "pack_id,case_id,case_key,input_template\n"
	prefix := "public-boundary-pack,public-boundary-case,public-boundary-key,"
	return header + prefix + strings.Repeat("x", size-len(header)-len(prefix)-1) + "\n"
}

func redTeamBoundaryMultipart(t *testing.T, csv, field, padding string) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile(field, "public-probes.csv")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.WriteString(part, csv); err != nil {
		t.Fatal(err)
	}
	if padding != "" {
		if err = writer.WriteField("note", padding); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, writer.FormDataContentType()
}

func TestRedTeamProbeCSVImportBodyBoundaries(t *testing.T) {
	for _, transport := range []string{"raw", "multipart"} {
		for _, overflow := range []bool{false, true} {
			name := transport + "/exact-limit"
			if overflow {
				name = transport + "/limit-plus-one"
			}
			t.Run(name, func(t *testing.T) {
				server, db, _ := newRedTeamTestServer(t)
				dir := t.TempDir()
				t.Setenv("TMPDIR", dir)
				pack := store.RedTeamProbePack{ID: "public-boundary-pack", Name: "preserve this pack", Enabled: true}
				original := store.RedTeamProbeCase{ID: "public-boundary-case", PackID: pack.ID, CaseKey: "public-boundary-key", InputTemplate: "keep original", Severity: "low"}
				if err := db.UpsertRedTeamProbePackWithCases(t.Context(), pack, []store.RedTeamProbeCase{original}); err != nil {
					t.Fatal(err)
				}
				csv := redTeamBoundaryCSV(int(redTeamProbeCSVMaxBytes))
				if overflow {
					csv += "\n"
				}
				var body io.Reader = strings.NewReader(csv)
				contentType := "text/csv"
				if transport == "multipart" {
					body, contentType = redTeamBoundaryMultipart(t, csv, "file", "")
				}
				request := httptest.NewRequest(http.MethodPost, "/admin/redteam/probe-packs/import", body)
				// Exercise the streaming limit rather than trusting Content-Length.
				request.ContentLength = -1
				request.Header.Set("Content-Type", contentType)
				response := httptest.NewRecorder()
				server.Routes().ServeHTTP(response, request)
				cases, err := db.RedTeamProbeCases(t.Context(), []string{pack.ID})
				if err != nil {
					t.Fatal(err)
				}
				if len(cases) != 1 {
					t.Fatalf("case count = %d", len(cases))
				}
				if overflow {
					if response.Code != http.StatusRequestEntityTooLarge {
						t.Fatalf("overflow status=%d response=%s", response.Code, response.Body.String())
					}
					if cases[0].InputTemplate != original.InputTemplate {
						t.Fatal("oversized CSV changed a case")
					}
					packs, err := db.ListRedTeamProbePacks(t.Context(), true)
					if err != nil {
						t.Fatal(err)
					}
					for _, stored := range packs {
						if stored.ID == pack.ID && stored.Name != pack.Name {
							t.Fatal("oversized CSV changed a pack")
						}
					}
					var failure struct {
						Error struct {
							Code string `json:"code"`
						} `json:"error"`
					}
					if err = json.Unmarshal(response.Body.Bytes(), &failure); err != nil {
						t.Fatal(err)
					}
					if failure.Error.Code != "csv_too_large" {
						t.Fatalf("error code=%q", failure.Error.Code)
					}
				} else {
					if response.Code != http.StatusOK {
						t.Fatalf("exact limit status=%d response=%s", response.Code, response.Body.String())
					}
					if len(cases[0].InputTemplate) != int(redTeamProbeCSVMaxBytes)-len("pack_id,case_id,case_key,input_template\npublic-boundary-pack,public-boundary-case,public-boundary-key,\n") {
						t.Fatal("exact-limit CSV content was truncated")
					}
				}
				files, err := os.ReadDir(dir)
				if err != nil {
					t.Fatal(err)
				}
				if len(files) != 0 {
					t.Fatalf("multipart temporary files retained: %d", len(files))
				}
			})
		}
	}
}

func TestRedTeamProbeCSVImportMultipartValidationBeforeWrites(t *testing.T) {
	for _, scenario := range []string{"small-file", "mixed-case-content-type", "missing-file", "malformed", "oversized-envelope"} {
		t.Run(scenario, func(t *testing.T) {
			server, db, _ := newRedTeamTestServer(t)
			dir := t.TempDir()
			t.Setenv("TMPDIR", dir)
			csv := "pack_id,case_id,case_key,input_template\npublic-small-pack,public-small-case,public-key,공개 합성 프롬프트\n"
			field := "file"
			padding := ""
			expected := http.StatusOK
			if scenario == "missing-file" {
				field = "other"
				expected = http.StatusBadRequest
			}
			if scenario == "oversized-envelope" {
				padding = strings.Repeat("x", int(redTeamProbeCSVMaxBytes+redTeamProbeMultipartOverhead))
				expected = http.StatusRequestEntityTooLarge
			}
			body, contentType := redTeamBoundaryMultipart(t, csv, field, padding)
			if scenario == "mixed-case-content-type" {
				contentType = strings.Replace(contentType, "multipart/form-data", "Multipart/Form-Data", 1)
			}
			if scenario == "malformed" {
				contentType = "multipart/form-data; boundary=missing"
				expected = http.StatusBadRequest
			}
			req := httptest.NewRequest(http.MethodPost, "/admin/redteam/probe-packs/import", body)
			req.Header.Set("Content-Type", contentType)
			response := httptest.NewRecorder()
			server.Routes().ServeHTTP(response, req)
			if response.Code != expected {
				t.Fatalf("status=%d want=%d body=%s", response.Code, expected, response.Body.String())
			}
			packs, err := db.ListRedTeamProbePacks(t.Context(), true)
			if err != nil {
				t.Fatal(err)
			}
			stored := 0
			for _, pack := range packs {
				if pack.ID == "public-small-pack" {
					stored += len(pack.Cases)
				}
			}
			if expected == http.StatusOK && stored != 1 {
				t.Fatalf("small multipart imported %d rows", stored)
			}
			if expected != http.StatusOK && stored != 0 {
				t.Fatalf("invalid multipart wrote %d rows", stored)
			}
			files, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			if len(files) != 0 {
				t.Fatal("multipart temporary files retained")
			}
		})
	}
}

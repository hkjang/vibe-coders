package store

import (
	"fmt"
	"testing"
)

func TestResourceSearchPromptNamesOnly(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	for i := 0; i < 13; i++ {
		id, name := fmt.Sprintf("prompt-%02d", i), fmt.Sprintf("정산 ÄBC %02d", i)
		if err := db.UpsertPromptTemplate(t.Context(), PromptTemplate{ID: id, Name: name, Body: "body-only-marker", Description: "description-only-marker", Category: "custom"}); err != nil {
			t.Fatal(err)
		}
		if err := db.CreatePromptExperiment(t.Context(), PromptExperiment{ID: id, Title: name, Description: "description-only-marker", Team: "team-only-marker", Owner: "owner-only-marker"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, kind := range []string{"prompt_asset", "prompt_experiment"} {
		for _, q := range []string{"정산", "äbc"} {
			rows, more, err := db.SearchResourceMetadata(t.Context(), kind, q, 10)
			if err != nil || len(rows) != 10 || !more || rows[0].ID != "prompt-00" || rows[9].ID != "prompt-09" {
				t.Fatalf("%s bounded name search: rows=%d more=%v err=%v", kind, len(rows), more, err)
			}
		}
		for _, q := range []string{"body-only-marker", "description-only-marker", "team-only-marker", "owner-only-marker", "prompt-00", "%_", "' OR 1=1 --"} {
			rows, _, err := db.SearchResourceMetadata(t.Context(), kind, q, 10)
			if err != nil || len(rows) != 0 {
				t.Fatalf("%s searched non-name content or interpreted syntax", kind)
			}
		}
	}
}

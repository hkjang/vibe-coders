package proxy

import "testing"

func TestNormalizeRecommendationFeedbackAction(t *testing.T) {
	cases := map[string]string{
		"accepted":  "adopted",
		"accept":    "adopted",
		"adopted":   "adopted",
		"rejected":  "dismissed",
		"reject":    "dismissed",
		"dismissed": "dismissed",
		"later":     "later",
		"snooze":    "later",
	}
	for input, want := range cases {
		got, ok := normalizeRecommendationFeedbackAction(input)
		if !ok || got != want {
			t.Fatalf("normalizeRecommendationFeedbackAction(%q) = %q/%v, want %q/true", input, got, ok, want)
		}
	}
	if got, ok := normalizeRecommendationFeedbackAction("wat"); ok || got != "" {
		t.Fatalf("unexpected valid action: %q/%v", got, ok)
	}
}

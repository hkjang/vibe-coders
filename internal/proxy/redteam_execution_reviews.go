package proxy

import (
	"crypto/rand"
	"encoding/base64"
	"sync"
	"time"
)

const redTeamReviewTTL = 5 * time.Minute
const redTeamReviewCapacity = 4096

// Server-local, short-lived admission capabilities. No proxy credential or
// prompt is retained. They deliberately fail closed after restart/on another pod.
type redTeamExecutionReviews struct {
	sync.Mutex
	entries map[string]redTeamExecutionReview
	running map[string]bool
}

type redTeamExecutionReview struct {
	Actor, CampaignID, Revision, Kind, Reason, ID string
	Models                                        []string
	Limits                                        redTeamRunLimits
	ExpiresAt                                     time.Time
}

func (reviews *redTeamExecutionReviews) issue(review redTeamExecutionReview) (string, bool) {
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", false
	}
	token := base64.RawURLEncoding.EncodeToString(nonce[:])
	reviews.Lock()
	defer reviews.Unlock()
	if reviews.entries == nil {
		reviews.entries = make(map[string]redTeamExecutionReview)
	}
	for token, entry := range reviews.entries {
		if !time.Now().Before(entry.ExpiresAt) {
			delete(reviews.entries, token)
		}
	}
	if len(reviews.entries) >= redTeamReviewCapacity {
		return "", false
	}
	reviews.entries[token] = review
	return token, true
}

// Consume BEFORE audit or dispatch. A lost response cannot reuse this review.
// Different valid reviews of the same campaign cannot overlap on this Server.
func (reviews *redTeamExecutionReviews) consume(token, actor, campaign string) (redTeamExecutionReview, bool) {
	reviews.Lock()
	defer reviews.Unlock()
	review, ok := reviews.entries[token]
	if !ok || review.Actor != actor || review.CampaignID != campaign {
		return redTeamExecutionReview{}, false
	}
	if !time.Now().Before(review.ExpiresAt) {
		delete(reviews.entries, token)
		return redTeamExecutionReview{}, false
	}
	if reviews.running[campaign] {
		return redTeamExecutionReview{}, false
	}
	delete(reviews.entries, token)
	if reviews.running == nil {
		reviews.running = make(map[string]bool)
	}
	reviews.running[campaign] = true
	return review, true
}

func (reviews *redTeamExecutionReviews) finish(campaign string) {
	reviews.Lock()
	defer reviews.Unlock()
	delete(reviews.running, campaign)
}

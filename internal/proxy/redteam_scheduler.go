package proxy

import (
	"context"
	"log/slog"
	"net/http/httptest"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// Red Team Scheduler (요건 §8 Scheduled Run, §28 step 9). A minute-ticker worker that fires due
// schedules automatically. Scheduled fires always run in SIMULATION (no proxy key is available to
// a background job), so they never make live upstream calls — matching the safety posture that
// live Active Controlled Runs are operator-initiated with an explicit redteam key.

// redTeamScheduleInterval maps a schedule expression to a fire interval. It intentionally supports
// a small, predictable vocabulary rather than full cron: "@hourly", "@daily", "@weekly", and
// "every:<n>m" / "every:<n>h". Unknown/empty expressions default to daily.
func redTeamScheduleInterval(expr string) time.Duration {
	e := strings.ToLower(strings.TrimSpace(expr))
	switch e {
	case "@hourly":
		return time.Hour
	case "@daily", "":
		return 24 * time.Hour
	case "@weekly":
		return 7 * 24 * time.Hour
	}
	if strings.HasPrefix(e, "every:") {
		spec := strings.TrimPrefix(e, "every:")
		if strings.HasSuffix(spec, "m") {
			if n, err := strconv.Atoi(strings.TrimSuffix(spec, "m")); err == nil && n > 0 {
				return time.Duration(n) * time.Minute
			}
		}
		if strings.HasSuffix(spec, "h") {
			if n, err := strconv.Atoi(strings.TrimSuffix(spec, "h")); err == nil && n > 0 {
				return time.Duration(n) * time.Hour
			}
		}
	}
	return 24 * time.Hour
}

// redTeamScheduleDue reports whether a schedule should fire now given its last run. A never-run
// schedule (empty/unparseable lastRunAt) is due immediately. Pure and testable.
func redTeamScheduleDue(cronExpr, lastRunAt string, now time.Time) bool {
	last, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(lastRunAt))
	if err != nil {
		last, err = time.Parse(time.RFC3339, strings.TrimSpace(lastRunAt))
	}
	if err != nil {
		return true // never run
	}
	return now.Sub(last) >= redTeamScheduleInterval(cronExpr)
}

// redTeamScheduler runs due red-team schedules once per minute.
func (s *Server) redTeamScheduler(parent context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-parent.Done():
			return
		case <-t.C:
		}
		if redteamKillSwitch.Load() {
			continue
		}
		ctx, cancel := context.WithTimeout(parent, 5*time.Minute)
		schedules, err := s.db.ListRedTeamSchedules(ctx)
		if err != nil {
			slog.Warn("redteam schedules query failed", "error", err)
			cancel()
			continue
		}
		now := time.Now().UTC()
		for _, sc := range schedules {
			if !sc.Enabled || !redTeamScheduleDue(sc.CronExpr, sc.LastRunAt, now) {
				continue
			}
			s.runScheduledRedTeamCampaign(ctx, sc)
		}
		cancel()
	}
}

// runScheduledRedTeamCampaign fires one due schedule's campaign template in simulation mode.
// It stamps last_run_at up front so a failing schedule doesn't retry every tick.
func (s *Server) runScheduledRedTeamCampaign(ctx context.Context, sc store.RedTeamSchedule) {
	_ = s.db.MarkRedTeamScheduleRun(ctx, sc.ID, time.Now().UTC().Format(time.RFC3339Nano))
	c, found, err := s.db.GetRedTeamCampaign(ctx, sc.CampaignTemplateID)
	if err != nil || !found {
		slog.Warn("redteam schedule campaign not found", "schedule", sc.ID, "campaign", sc.CampaignTemplateID)
		return
	}
	// Background fires are simulation-only: no proxy key, so redTeamActiveEligible is always false.
	synthReq := httptest.NewRequest("POST", "/admin/redteam/scheduler", nil).WithContext(ctx)
	// runRedTeamCampaign already emits the critical Mattermost alert (§27.8) for both manual and
	// scheduled runs, so the scheduler doesn't duplicate it here.
	if _, err := s.runRedTeamCampaign(synthReq, c, ""); err != nil {
		slog.Warn("redteam scheduled run failed", "schedule", sc.ID, "campaign", c.ID, "error", err)
		return
	}
	slog.Info("redteam scheduled run completed", "schedule", sc.ID, "campaign", c.ID)
}

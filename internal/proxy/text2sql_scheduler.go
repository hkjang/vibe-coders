package proxy

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/text2sql"
)

// text2sqlReportScheduler periodically runs due saved reports (read-only) and delivers
// a short result summary to Mattermost when configured. It self-disables when no
// execute DB is set — scheduled reports need a place to run.
func (s *Server) text2sqlReportScheduler() {
	if s.t2sConf().ExecDSN == "" {
		return
	}
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		due, err := s.db.DueText2SQLReports(ctx, time.Now().UTC())
		if err != nil {
			slog.Warn("due reports query failed", "error", err)
			cancel()
			continue
		}
		for _, rep := range due {
			s.runScheduledReport(ctx, rep)
		}
		cancel()
	}
}

// runScheduledReport executes one saved report's SQL read-only and (optionally) posts a
// summary to Mattermost. It always records the run time so a failing report doesn't
// retry every tick.
func (s *Server) runScheduledReport(ctx context.Context, rep store.Text2SQLSavedReport) {
	cfg := s.t2sConf()
	// Record the attempt up front to space out retries by the configured interval.
	_ = s.db.MarkText2SQLReportRun(ctx, rep.ID, time.Now().UTC().Format(time.RFC3339Nano))

	if rep.SQL == "" {
		return
	}
	validation := text2sql.ValidateSQL(rep.SQL, text2sql.ValidateOptions{DefaultLimit: cfg.DefaultLimit, MaxLimit: cfg.MaxLimit})
	if !validation.OK {
		slog.Warn("scheduled report SQL failed validation", "report", rep.Name, "reason", validation.Reason)
		if rep.DeliverMattermost {
			s.notifyMattermost(ctx, "text2sql_report", fmt.Sprintf("리포트 '%s' 실행 보류: SQL 검증 실패(%s)", rep.Name, validation.Reason))
		}
		return
	}
	db, err := s.text2sqlExecDB()
	if err != nil {
		slog.Warn("scheduled report exec db unavailable", "report", rep.Name, "error", err)
		return
	}
	rowCap := cfg.MaxLimit
	if rowCap <= 0 {
		rowCap = 1000
	}
	_, _, rowCount, execErr := executeReadOnlyQuery(ctx, db, cfg.ExecDriver, validation.SQL, rowCap, cfg.StatementTimeout, cfg.WorkMem)
	if execErr != nil {
		slog.Warn("scheduled report execution failed", "report", rep.Name, "error", execErr)
		if rep.DeliverMattermost {
			s.notifyMattermost(ctx, "text2sql_report", fmt.Sprintf("리포트 '%s' 실행 실패: %s", rep.Name, execErr.Error()))
		}
		return
	}
	slog.Info("scheduled report executed", "report", rep.Name, "rows", rowCount)
	if rep.DeliverMattermost {
		s.notifyMattermost(ctx, "text2sql_report", fmt.Sprintf("리포트 '%s' 실행 완료: %d행", rep.Name, rowCount))
	}
}

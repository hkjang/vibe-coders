package proxy

import (
	"context"
	"errors"
	"fmt"
	"time"
	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

const clickhouseSinkBatchSize = 1000

func (s *Server) prepareClickHouseSink(ctx context.Context, dimension, since string, until time.Time) (store.ClickHouseSinkRange, *store.ClickHouseSinkRetry, error) {
	interval, err := (store.ClickHouseSinkRange{Dimension: dimension, Since: since, Until: until.UTC().Format(time.RFC3339Nano)}).Normalized()
	if err != nil {
		return interval, nil, err
	}
	pending, err := s.db.ClickHouseSinkRetrySnapshot(ctx, dimension)
	if err != nil {
		return interval, nil, err
	}
	if pending != nil {
		failed, err := (store.ClickHouseSinkRange{Dimension: dimension, Since: pending.SinceDay, Until: interval.Until}).Normalized()
		if err != nil {
			return interval, nil, err
		}
		if failed.Since < interval.Since {
			interval.Since = failed.Since
		}
	}
	return interval, pending, nil
}

// sendClickHouseInterval is shared by manual, retry and automatic sinks. Each
// batch is bounded; the closed interval is fixed before the first external call.
// Only a completely delivered interval may acknowledge its observed failure.
func (s *Server) sendClickHouseInterval(ctx context.Context, cfg config.ClickHouseConfig, interval store.ClickHouseSinkRange, pending *store.ClickHouseSinkRetry) (int, error) {
	return s.sendClickHouseIntervalProgress(ctx, cfg, interval, pending, nil)
}

func (s *Server) sendClickHouseIntervalProgress(ctx context.Context, cfg config.ClickHouseConfig, interval store.ClickHouseSinkRange, pending *store.ClickHouseSinkRetry, progress func(int) error) (total int, err error) {
	if cfg.URL == "" {
		return 0, errors.New("ClickHouse is not configured")
	}
	if (interval.Dimension == "text2sql_fact" && cfg.Text2SQLFactTable == "") || (interval.Dimension == "redteam_fact" && cfg.RedTeamFactTable == "") {
		return 0, errors.New("fact table is not configured; retry remains queued")
	}
	interval, err = interval.Normalized()
	if err != nil {
		return 0, err
	}
	// Retry persistence must survive a canceled HTTP response, while remaining
	// bounded to a short cleanup deadline rather than an unbounded goroutine.
	defer func() {
		if err == nil {
			return
		}
		failureCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if recordErr := s.db.RecordClickHouseSinkFailure(failureCtx, interval.Dimension, interval.Since, "sink attempt incomplete"); recordErr != nil {
			err = errors.Join(err, fmt.Errorf("could not persist sink retry: %w", recordErr))
		}
	}()
	cursor := store.ClickHouseSinkCursor{}
	last := interval.Since
	for {
		if progress != nil {
			if progressErr := progress(total); progressErr != nil {
				return total, progressErr
			}
		}
		batch, readErr := s.db.ReadClickHouseSinkBatch(ctx, interval, cursor, clickhouseSinkBatchSize)
		if readErr != nil {
			return total, readErr
		}
		if batch.Len() == 0 {
			break
		}
		if cursor.Position != "" && (batch.Next.Position < cursor.Position || (batch.Next.Position == cursor.Position && batch.Next.ID <= cursor.ID)) {
			return total, errors.New("sink cursor did not advance")
		}
		var sent int
		switch interval.Dimension {
		case "text2sql_fact":
			sent, err = clickhouseText2SQLFactSink(ctx, s.client, cfg, batch.Text2SQL)
		case "redteam_fact":
			sent, err = clickhouseRedTeamFactSink(ctx, s.client, cfg, batch.RedTeam)
		default:
			sent, err = clickhouseSink(ctx, s.client, cfg, batch.Rollups)
		}
		if err != nil {
			return total, errors.New("ClickHouse batch delivery failed; retry remains queued")
		}
		if sent != batch.Len() {
			return total, errors.New("ClickHouse did not accept the complete batch")
		}
		total += sent
		if progress != nil {
			if progressErr := progress(total); progressErr != nil {
				return total, progressErr
			}
		}
		cursor = batch.Next
		last = cursor.Position
	}
	_, completeErr := s.db.CompleteClickHouseSink(ctx, interval.Dimension, last, int64(total), pending)
	if completeErr != nil {
		return total, completeErr
	}
	// A newer failure is deliberately retained without being overwritten or bumped.
	// The retry endpoint reports it as pending even though this interval was sent.
	return total, nil
}

func (s *Server) syncClickHouseDimension(ctx context.Context, dimension, since string) (int, error) {
	cfg := s.chConf()
	interval, pending, err := s.prepareClickHouseSink(ctx, dimension, since, time.Now().UTC())
	if err != nil {
		return 0, err
	}
	return s.sendClickHouseInterval(ctx, cfg, interval, pending)
}

func (s *Server) syncClickHouseFactDimension(ctx context.Context, dimension string) (int, error) {
	cfg := s.chConf()
	if cfg.URL == "" || (dimension == "text2sql_fact" && cfg.Text2SQLFactTable == "") || (dimension == "redteam_fact" && cfg.RedTeamFactTable == "") {
		return 0, nil
	}
	since := time.Now().UTC().AddDate(0, 0, -7).Format(time.RFC3339Nano)
	states, err := s.db.ListClickHouseSinkState(ctx)
	if err != nil {
		return 0, err
	}
	for _, state := range states {
		if state.Dimension == dimension && state.LastSyncedDay != "" {
			since = state.LastSyncedDay
			break
		}
	}
	interval, pending, err := s.prepareClickHouseSink(ctx, dimension, since, time.Now().UTC())
	if err != nil {
		return 0, err
	}
	return s.sendClickHouseInterval(ctx, cfg, interval, pending)
}

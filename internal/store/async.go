package store

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type AsyncLogger struct {
	store        *SQLStore
	ch           chan LogRecord
	fallbackPath string
	done         chan struct{}
	wg           sync.WaitGroup
	fallbackMu   sync.Mutex
	dropped      atomic.Uint64
	written      atomic.Uint64
}

type FallbackStats struct {
	Path       string `json:"path"`
	Exists     bool   `json:"exists"`
	Bytes      int64  `json:"bytes"`
	Lines      int64  `json:"lines"`
	ModifiedAt string `json:"modified_at"`
}

type FallbackReplayResult struct {
	Path       string `json:"path"`
	Imported   int64  `json:"imported"`
	Duplicates int64  `json:"duplicates"`
	Failed     int64  `json:"failed"`
	Remaining  int64  `json:"remaining"`
	Removed    bool   `json:"removed"`
}

func NewAsyncLogger(store *SQLStore, queueSize int, fallbackPath string) *AsyncLogger {
	return &AsyncLogger{
		store:        store,
		ch:           make(chan LogRecord, queueSize),
		fallbackPath: fallbackPath,
		done:         make(chan struct{}),
	}
}

func (l *AsyncLogger) Start() {
	l.wg.Add(1)
	go l.run()
}

func (l *AsyncLogger) Stop(ctx context.Context) {
	close(l.done)
	finished := make(chan struct{})
	go func() {
		l.wg.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-ctx.Done():
		slog.Warn("async logger shutdown timed out", "error", ctx.Err())
	}
}

func (l *AsyncLogger) Enqueue(record LogRecord) {
	select {
	case l.ch <- record:
	default:
		l.dropped.Add(1)
	}
}

func (l *AsyncLogger) QueueDepth() int {
	return len(l.ch)
}

func (l *AsyncLogger) Dropped() uint64 {
	return l.dropped.Load()
}

func (l *AsyncLogger) Written() uint64 {
	return l.written.Load()
}

func (l *AsyncLogger) FallbackStats() (FallbackStats, error) {
	stats := FallbackStats{Path: l.fallbackPath}
	if l.fallbackPath == "" {
		return stats, nil
	}
	l.fallbackMu.Lock()
	defer l.fallbackMu.Unlock()

	info, err := os.Stat(l.fallbackPath)
	if errors.Is(err, os.ErrNotExist) {
		return stats, nil
	}
	if err != nil {
		return stats, err
	}
	stats.Exists = true
	stats.Bytes = info.Size()
	stats.ModifiedAt = info.ModTime().UTC().Format(time.RFC3339Nano)

	file, err := os.Open(l.fallbackPath)
	if err != nil {
		return stats, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) != "" {
			stats.Lines++
		}
	}
	return stats, scanner.Err()
}

func (l *AsyncLogger) ReplayFallback(ctx context.Context) (FallbackReplayResult, error) {
	result := FallbackReplayResult{Path: l.fallbackPath}
	if l.fallbackPath == "" {
		return result, nil
	}
	l.fallbackMu.Lock()
	defer l.fallbackMu.Unlock()

	file, err := os.Open(l.fallbackPath)
	if errors.Is(err, os.ErrNotExist) {
		result.Removed = true
		return result, nil
	}
	if err != nil {
		return result, err
	}

	tmpPath := l.fallbackPath + ".replay.tmp"
	tmp, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return result, err
	}
	defer tmp.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var record LogRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			result.Failed++
			result.Remaining++
			_, _ = tmp.WriteString(line + "\n")
			continue
		}
		if err := l.store.InsertLogRecord(ctx, record); err != nil {
			if duplicateLogRecordError(err) {
				result.Duplicates++
				continue
			}
			result.Failed++
			result.Remaining++
			_, _ = tmp.WriteString(line + "\n")
			continue
		}
		result.Imported++
	}
	if err := scanner.Err(); err != nil {
		_ = file.Close()
		return result, err
	}
	if err := file.Close(); err != nil {
		return result, err
	}
	if err := tmp.Close(); err != nil {
		return result, err
	}
	if result.Remaining == 0 {
		if err := os.Remove(l.fallbackPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return result, err
		}
		_ = os.Remove(tmpPath)
		result.Removed = true
		return result, nil
	}
	if err := os.Remove(l.fallbackPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return result, err
	}
	if err := os.Rename(tmpPath, l.fallbackPath); err != nil {
		return result, err
	}
	return result, nil
}

func (l *AsyncLogger) run() {
	defer l.wg.Done()
	for {
		select {
		case record := <-l.ch:
			l.write(record)
		case <-l.done:
			for {
				select {
				case record := <-l.ch:
					l.write(record)
				default:
					return
				}
			}
		}
	}
}

func (l *AsyncLogger) write(record LogRecord) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := l.store.InsertLogRecord(ctx, record); err != nil {
		slog.Warn("write audit log failed", "error", err)
		l.writeFallback(record)
		_ = l.store.InsertSystemError(ctx, "async_logger", "Write audit log failed: "+err.Error())
		return
	}
	l.written.Add(1)
}

func (l *AsyncLogger) writeFallback(record LogRecord) {
	if l.fallbackPath == "" {
		return
	}
	l.fallbackMu.Lock()
	defer l.fallbackMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(l.fallbackPath), 0o755); err != nil {
		slog.Warn("create fallback log directory failed", "error", err)
		return
	}
	file, err := os.OpenFile(l.fallbackPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		slog.Warn("open fallback log failed", "error", err)
		return
	}
	defer file.Close()
	encoded, err := json.Marshal(record)
	if err != nil {
		return
	}
	_, _ = file.Write(append(encoded, '\n'))
}

func duplicateLogRecordError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "unique constraint") ||
		strings.Contains(msg, "duplicate key") ||
		strings.Contains(msg, "constraint failed")
}

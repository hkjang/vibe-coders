package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/proxy"
	"vibe-coders/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	db, err := store.Open(context.Background(), cfg.Database)
	if err != nil {
		slog.Error("open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := db.Migrate(context.Background()); err != nil {
		slog.Error("migrate database", "error", err)
		os.Exit(1)
	}

	logger := store.NewAsyncLogger(db, cfg.Logging.QueueSize, cfg.Logging.FallbackPath)
	logger.Start()
	defer logger.Stop(context.Background())

	retention := store.NewRetentionWorker(db, cfg.Retention)
	retention.Start()
	defer retention.Stop()

	srv, err := proxy.NewServer(cfg, db, logger, retention)
	if err != nil {
		slog.Error("create proxy server", "error", err)
		os.Exit(1)
	}

	alerts := proxy.NewAlertWorker(db, srv.MetricsHandle(), 60*time.Second)
	alerts.Start()
	defer alerts.Stop()

	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("AI Coding Proxy Gateway listening", "addr", cfg.ListenAddr, "database", cfg.Database.Driver)
		errCh <- httpServer.ListenAndServe()
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	select {
	case sig := <-stop:
		slog.Info("shutdown requested", "signal", sig.String())
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server stopped", "error", err)
			os.Exit(1)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
}

package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"vibe-coders/internal/datadir"
	"vibe-coders/internal/proxy"
)

// defaultDataDir matches the runtime image's DB_DSN=/data/gateway.db.
const defaultDataDir = "/data"

// runMaintenanceCommand handles the subcommands an operator can run from the
// release image without a shell: `docker run --rm ... IMAGE check-data-dir`.
// It reports whether args named a subcommand and the exit code to use.
func runMaintenanceCommand(args []string, stdout, stderr io.Writer) (int, bool) {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return 0, false
	}
	switch args[0] {
	case "version":
		fmt.Fprintln(stdout, proxy.AppVersion)
		return 0, true
	case "check-data-dir":
		return runCheckDataDir(args[1:], stdout, stderr), true
	case "repair-data-dir":
		return runRepairDataDir(args[1:], stdout, stderr), true
	case "help", "-h", "--help":
		printMaintenanceUsage(stdout)
		return 0, true
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n", args[0])
		printMaintenanceUsage(stderr)
		return 2, true
	}
}

func printMaintenanceUsage(w io.Writer) {
	fmt.Fprintf(w, `usage: gateway [command]

Without a command the gateway starts and serves LISTEN_ADDR (default :8080).

commands:
  check-data-dir [DIR]                 verify DIR (default: directory of DB_DSN, else %s) is usable
                                       by this process; exit 1 with the reason and the fix otherwise
  repair-data-dir [--uid N] [--gid N] [DIR]
                                       chown DIR recursively to uid:gid (default %d:%d, the image's
                                       nonroot user) and restore owner read/write; run once as root:
                                       docker run --rm --user 0:0 --mount source=proxy-gateway-data,target=/data IMAGE repair-data-dir
  version                              print the build version
`, defaultDataDir, datadir.DefaultUID, datadir.DefaultGID)
}

// stateDir returns the directory the check and repair commands act on: an explicit
// argument, else the directory of the SQLite DSN, else the image default.
func stateDir(args []string) (string, error) {
	switch len(args) {
	case 0:
	case 1:
		return filepath.Clean(args[0]), nil
	default:
		return "", fmt.Errorf("expected at most one directory, got %d arguments", len(args))
	}
	if dbPath, ok := sqliteDSNPath(); ok {
		return filepath.Dir(dbPath), nil
	}
	return defaultDataDir, nil
}

func sqliteDSNPath() (string, bool) {
	driver := strings.ToLower(strings.TrimSpace(os.Getenv("DB_DRIVER")))
	if driver != "" && driver != "sqlite" {
		return "", false
	}
	dsn := strings.TrimSpace(os.Getenv("DB_DSN"))
	if dsn == "" {
		return "", false
	}
	path, ok := datadir.SQLitePath(dsn)
	if !ok || !filepath.IsAbs(path) {
		return "", false
	}
	return path, true
}

func runCheckDataDir(args []string, stdout, stderr io.Writer) int {
	dir, err := stateDir(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	var problems []string
	// When the SQLite database lives in dir, check it and its WAL as files, not just
	// the directory: a root-owned gateway.db inside a nonroot-owned /data is the
	// common upgrade case. Check covers the directory probe as well.
	if dbPath, ok := sqliteDSNPath(); ok && filepath.Dir(dbPath) == dir {
		var dataErr *datadir.Error
		if err := datadir.Check(dbPath); errors.As(err, &dataErr) {
			for _, p := range dataErr.Problems {
				line := p.Path
				if p.Owner != "" {
					line += fmt.Sprintf(" (owner %s, mode %s)", p.Owner, p.Mode)
				}
				problems = append(problems, line+": "+p.Detail)
			}
		} else if err != nil {
			problems = append(problems, err.Error())
		}
	} else if err := datadir.CheckDir(dir); err != nil {
		problems = append(problems, err.Error())
	}
	if len(problems) == 0 {
		fmt.Fprintf(stdout, "OK %s is usable by the gateway process\n", dir)
		return 0
	}
	fmt.Fprintf(stderr, "%s is not usable by the gateway process:\n", dir)
	for _, p := range problems {
		fmt.Fprintf(stderr, "  - %s\n", p)
	}
	fmt.Fprintln(stderr, datadir.RepairHint(dir))
	return 1
}

func runRepairDataDir(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("repair-data-dir", flag.ContinueOnError)
	fs.SetOutput(stderr)
	uid := fs.Int("uid", datadir.DefaultUID, "owner uid to apply")
	gid := fs.Int("gid", datadir.DefaultGID, "owner gid to apply")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	dir, err := stateDir(fs.Args())
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if *uid < 0 || *gid < 0 {
		fmt.Fprintln(stderr, "--uid and --gid must be non-negative")
		return 2
	}
	summary, err := datadir.Repair(dir, *uid, *gid)
	if err != nil {
		fmt.Fprintf(stderr, "repair %s: %v\n", dir, err)
		if len(summary.Chowned)+len(summary.Chmoded) > 0 {
			fmt.Fprintf(stderr, "partial changes were applied to %d entries before the failure\n", len(summary.Chowned)+len(summary.Chmoded))
		}
		return 1
	}
	fmt.Fprintf(stdout, "repaired %s for uid=%d gid=%d: %d entries visited, %d re-owned, %d permission fixes\n",
		summary.Root, summary.UID, summary.GID, summary.Visited, len(summary.Chowned), len(summary.Chmoded))
	for _, p := range summary.Chowned {
		fmt.Fprintf(stdout, "  chown %s\n", p)
	}
	for _, p := range summary.Chmoded {
		fmt.Fprintf(stdout, "  chmod %s\n", p)
	}
	fmt.Fprintf(stdout, "verify as the runtime user with: gateway check-data-dir %s\n", dir)
	return 0
}

// describeStartupError adds the repair instructions to SQLite's readonly failure
// when it surfaces after the preflight, e.g. a sidecar created between the two.
func describeStartupError(err error, dsn string) error {
	if err == nil {
		return nil
	}
	msg := strings.ToLower(err.Error())
	if !strings.Contains(msg, "readonly database") && !strings.Contains(msg, "unable to open database file") {
		return err
	}
	dir := defaultDataDir
	if path, ok := datadir.SQLitePath(dsn); ok {
		dir = filepath.Dir(path)
	}
	return fmt.Errorf("%w. %s", err, datadir.RepairHint(dir))
}

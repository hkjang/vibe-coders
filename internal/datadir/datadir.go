// Package datadir diagnoses and repairs the on-disk state directory the gateway
// needs when it runs on SQLite.
//
// The runtime image executes as nonroot (uid 65532) and has neither a shell nor
// chown, so a /data directory that a root process, a bind mount or a Kubernetes
// volume left owned by another user makes the gateway die at startup with an
// opaque "attempt to write a readonly database" error and port 8080 never opens.
// Check turns that into a message naming the file, its owner and the one command
// that fixes it; Repair is that command, run once as root from the same image.
package datadir

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DefaultUID and DefaultGID are the distroless "nonroot" identity the runtime
// image runs the gateway as.
const (
	DefaultUID = 65532
	DefaultGID = 65532
)

// sqliteSidecars are the files SQLite creates next to the database. A database
// file the process may write but a WAL it may not still fails the first commit,
// so every existing sidecar is checked and repaired together with the database.
var sqliteSidecars = []string{"-wal", "-shm", "-journal"}

// SQLitePath extracts the database file from a modernc/sqlite DSN. The second
// result is false for in-memory databases, which have no directory to check.
func SQLitePath(dsn string) (string, bool) {
	path := dsn
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	path = strings.TrimPrefix(path, "file:")
	if path == "" || path == ":memory:" {
		return "", false
	}
	if strings.Contains(dsn, "mode=memory") {
		return "", false
	}
	return path, true
}

// Problem is one path the current process cannot use the way SQLite needs.
type Problem struct {
	Path   string
	Detail string
	Owner  string // "uid:gid" when the platform exposes it, otherwise ""
	Mode   fs.FileMode
}

// Error reports why a SQLite state directory is unusable by the current process.
type Error struct {
	DBPath   string
	Dir      string
	UID      int
	GID      int
	Problems []Problem
}

func (e *Error) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "data directory %s is not writable by the gateway process (uid=%d gid=%d)", e.Dir, e.UID, e.GID)
	for _, p := range e.Problems {
		b.WriteString("; ")
		b.WriteString(p.Path)
		if p.Owner != "" {
			fmt.Fprintf(&b, " (owner %s, mode %s)", p.Owner, p.Mode)
		}
		b.WriteString(": ")
		b.WriteString(p.Detail)
	}
	b.WriteString(". ")
	b.WriteString(RepairHint(e.Dir))
	return b.String()
}

// RepairHint is the operator-facing instruction appended to every data
// directory failure. The image tag comes from GATEWAY_VERSION, which the
// shipped env file always carries, so the printed command can be pasted as is.
func RepairHint(dir string) string {
	image := "ai-coding-proxy-gateway:" + imageVersion()
	return fmt.Sprintf("The container runs as nonroot (uid %d); a volume, bind mount or Kubernetes PVC written by another user must be repaired once, as root, with the same image: "+
		"docker run --rm --user 0:0 --mount source=proxy-gateway-data,target=%s %s repair-data-dir %s "+
		"(for a bind mount use -v <host dir>:%s; on Kubernetes set securityContext.fsGroup=%d or run the same command as an init container). "+
		"The change is reported by \"docker logs\" and by: docker run --rm --mount source=proxy-gateway-data,target=%s %s check-data-dir %s",
		DefaultUID, dir, image, dir, dir, DefaultGID, dir, image, dir)
}

func imageVersion() string {
	if v := strings.TrimSpace(os.Getenv("GATEWAY_VERSION")); v != "" {
		return v
	}
	return "<version>"
}

// Check verifies that the current process can create and modify files in the
// SQLite database's directory, and can write the database and any existing
// sidecar. It probes with real syscalls, so group permissions granted through a
// Kubernetes fsGroup or an ACL count. It never modifies persistent state: the
// only write is a probe file that is removed again.
func Check(dbPath string) error {
	dir := filepath.Dir(dbPath)
	uid, gid := processIdentity()
	var problems []Problem

	info, err := os.Stat(dir)
	switch {
	case err != nil:
		problems = append(problems, Problem{Path: dir, Detail: err.Error()})
	case !info.IsDir():
		problems = append(problems, Problem{Path: dir, Detail: "not a directory", Owner: ownerOf(info), Mode: info.Mode()})
	default:
		if err := probeDirWritable(dir); err != nil {
			problems = append(problems, Problem{Path: dir, Detail: "cannot create files: " + err.Error(), Owner: ownerOf(info), Mode: info.Mode()})
		}
	}

	for _, path := range append([]string{dbPath}, sidecarPaths(dbPath)...) {
		info, err := os.Stat(path)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				problems = append(problems, Problem{Path: path, Detail: err.Error()})
			}
			continue
		}
		if info.IsDir() {
			problems = append(problems, Problem{Path: path, Detail: "is a directory", Owner: ownerOf(info), Mode: info.Mode()})
			continue
		}
		f, err := os.OpenFile(path, os.O_RDWR, 0)
		if err != nil {
			problems = append(problems, Problem{Path: path, Detail: "cannot open for writing: " + err.Error(), Owner: ownerOf(info), Mode: info.Mode()})
			continue
		}
		f.Close()
	}

	if len(problems) == 0 {
		return nil
	}
	return &Error{DBPath: dbPath, Dir: dir, UID: uid, GID: gid, Problems: problems}
}

// CheckDir verifies only that files can be created in dir. It backs the
// non-fatal warning for the fallback log directory.
func CheckDir(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", dir)
	}
	if err := probeDirWritable(dir); err != nil {
		uid, gid := processIdentity()
		return fmt.Errorf("%s (owner %s, mode %s) is not writable by uid=%d gid=%d: %w", dir, ownerOf(info), info.Mode(), uid, gid, err)
	}
	return nil
}

func probeDirWritable(dir string) error {
	f, err := os.CreateTemp(dir, ".gateway-write-check-*")
	if err != nil {
		return err
	}
	name := f.Name()
	f.Close()
	return os.Remove(name)
}

func sidecarPaths(dbPath string) []string {
	out := make([]string, 0, len(sqliteSidecars))
	for _, suffix := range sqliteSidecars {
		out = append(out, dbPath+suffix)
	}
	return out
}

// Summary describes what Repair changed.
type Summary struct {
	Root    string
	UID     int
	GID     int
	Visited int
	Chowned []string
	Chmoded []string
}

// Repair makes every entry under root owned by uid:gid and guarantees the owner
// can read and write files and traverse directories. Other permission bits are
// preserved; symbolic links are re-owned but never followed, so a link planted
// in the volume cannot redirect the repair outside it. It is idempotent and
// reports every change it made so an operator can audit the result.
func Repair(root string, uid, gid int) (Summary, error) {
	if err := platformSupportsRepair(); err != nil {
		return Summary{}, err
	}
	root = filepath.Clean(root)
	info, err := os.Lstat(root)
	if err != nil {
		return Summary{}, err
	}
	if !info.IsDir() {
		return Summary{}, fmt.Errorf("%s is not a directory", root)
	}
	summary := Summary{Root: root, UID: uid, GID: gid}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		summary.Visited++
		if ownerUID, ownerGID, ok := ownerIDs(info); !ok || ownerUID != uid || ownerGID != gid {
			if err := os.Lchown(path, uid, gid); err != nil {
				return fmt.Errorf("chown %s: %w", path, err)
			}
			summary.Chowned = append(summary.Chowned, path)
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			return nil
		}
		want := info.Mode().Perm() | 0o600
		if info.IsDir() {
			want |= 0o700
		}
		if want != info.Mode().Perm() {
			if err := os.Chmod(path, want); err != nil {
				return fmt.Errorf("chmod %s: %w", path, err)
			}
			summary.Chmoded = append(summary.Chmoded, path)
		}
		return nil
	})
	if err != nil {
		return summary, err
	}
	sort.Strings(summary.Chowned)
	sort.Strings(summary.Chmoded)
	return summary, nil
}

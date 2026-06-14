//go:build !windows

package proxy

import "syscall"

// diskUsage returns free and total bytes for the filesystem containing path.
// ok is false when the platform call fails (path missing, permission, etc.).
func diskUsage(path string) (freeBytes, totalBytes uint64, ok bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, false
	}
	bsize := uint64(st.Bsize)
	return st.Bavail * bsize, st.Blocks * bsize, true
}

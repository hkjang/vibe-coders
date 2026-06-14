//go:build windows

package proxy

import (
	"syscall"
	"unsafe"
)

// diskUsage returns free and total bytes for the volume containing path.
// ok is false when the platform call fails (path missing, permission, etc.).
func diskUsage(path string) (freeBytes, totalBytes uint64, ok bool) {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceEx := kernel32.NewProc("GetDiskFreeSpaceExW")

	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, false
	}
	var freeAvailable, total, totalFree uint64
	r, _, _ := getDiskFreeSpaceEx.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&freeAvailable)),
		uintptr(unsafe.Pointer(&total)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		return 0, 0, false
	}
	return freeAvailable, total, true
}

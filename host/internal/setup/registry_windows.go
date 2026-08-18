//go:build windows

package setup

import (
	"bufio"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// hkcuPrefix is prepended to every RegistryWriter path before it reaches
// reg.exe: Target.RegistryPath stores the subkey relative to
// HKEY_CURRENT_USER, including the host-name leaf (e.g.
// `Software\Google\Chrome\NativeMessagingHosts\com.barad1tos.mimicengine`).
const hkcuPrefix = `HKCU\`

// realRegistry implements RegistryWriter by shelling out to reg.exe.
//
// Tradeoff, documented rather than hidden: host/go.mod is stdlib-only (see
// its package doc), which rules out golang.org/x/sys/windows/registry —
// the direct win32 registry API. reg.exe is the only stdlib-reachable path
// to HKEY_CURRENT_USER left, at the cost of a process spawn per call and
// parsing its human-oriented text output instead of reading structured
// data. Both costs are acceptable here: install/uninstall/doctor invoke
// this a handful of times per run, never in a hot path.
type realRegistry struct{}

// NewRegistryWriter returns this OS's RegistryWriter implementation.
func NewRegistryWriter() RegistryWriter { return realRegistry{} }

func (realRegistry) keyExists(path string) (bool, error) {
	err := exec.Command("reg", "query", hkcuPrefix+path).Run()
	if err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return false, nil // reg.exe exits non-zero when the key does not exist
	}
	return false, fmt.Errorf("reg query %q: %w", path, err)
}

// value reads path's DEFAULT (unnamed) value — the shape Chrome/Firefox
// actually read a native-messaging host's manifest path from (see
// setValue). /ve queries that value specifically, never a named sibling.
func (realRegistry) value(path string) (string, bool, error) {
	out, err := exec.Command("reg", "query", hkcuPrefix+path, "/ve").Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("reg query %q /ve: %w", path, err)
	}
	return parseRegQueryDefaultValue(string(out))
}

// setValue creates path if it does not already exist and writes data into
// its DEFAULT (unnamed) value via /ve — the registry shape Chrome/Firefox
// require: HKCU\...\NativeMessagingHosts\<host name>'s default value holds
// the manifest's absolute path, not a value named after the host under a
// shared parent key.
func (realRegistry) setValue(path, data string) error {
	cmd := exec.Command("reg", "add", hkcuPrefix+path, "/ve", "/t", "REG_SZ", "/d", data, "/f")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("reg add %q /ve: %w (%s)", path, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// deleteValue removes path's default value via /ve — the inverse of
// setValue. It leaves the (now-valueless) key itself in place rather than
// deleting the key outright; deleting a value that is already absent is
// not an error, so uninstall stays idempotent.
func (realRegistry) deleteValue(path string) error {
	cmd := exec.Command("reg", "delete", hkcuPrefix+path, "/ve", "/f")
	out, err := cmd.CombinedOutput()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return nil // already absent; uninstall stays idempotent
		}
		return fmt.Errorf("reg delete %q /ve: %w (%s)", path, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// parseRegQueryDefaultValue extracts a key's default (unnamed) value from
// `reg query <path> /ve` output. reg.exe labels that line "(Default)"
// literally, in the same whitespace-separated "<name> <type> <data>" shape
// a named value uses; every other line (the key header, blank separators)
// is ignored.
func parseRegQueryDefaultValue(output string) (string, bool, error) {
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 3 || fields[0] != "(Default)" {
			continue
		}
		return strings.Join(fields[2:], " "), true, nil
	}
	if err := scanner.Err(); err != nil {
		return "", false, fmt.Errorf("parsing reg query output: %w", err)
	}
	return "", false, nil
}

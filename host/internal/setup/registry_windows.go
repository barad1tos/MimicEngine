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
// HKEY_CURRENT_USER (e.g. `Software\Google\Chrome\NativeMessagingHosts`).
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

func (realRegistry) value(path, name string) (string, bool, error) {
	out, err := exec.Command("reg", "query", hkcuPrefix+path, "/v", name).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("reg query %q /v %q: %w", path, name, err)
	}
	return parseRegQueryValue(string(out), name)
}

func (realRegistry) setValue(path, name, data string) error {
	cmd := exec.Command("reg", "add", hkcuPrefix+path, "/v", name, "/t", "REG_SZ", "/d", data, "/f")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("reg add %q /v %q: %w (%s)", path, name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (realRegistry) deleteValue(path, name string) error {
	cmd := exec.Command("reg", "delete", hkcuPrefix+path, "/v", name, "/f")
	out, err := cmd.CombinedOutput()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return nil // already absent; uninstall stays idempotent
		}
		return fmt.Errorf("reg delete %q /v %q: %w (%s)", path, name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// parseRegQueryValue extracts name's data from `reg query <path> /v <name>`
// output. The relevant line has the form "    <name>    REG_SZ    <data>",
// fields separated by runs of whitespace; every other line (the key header,
// blank separators) is ignored.
func parseRegQueryValue(output, name string) (string, bool, error) {
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 3 || fields[0] != name {
			continue
		}
		return strings.Join(fields[2:], " "), true, nil
	}
	if err := scanner.Err(); err != nil {
		return "", false, fmt.Errorf("parsing reg query output: %w", err)
	}
	return "", false, nil
}

package setup

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// Detected returns the subset of all whose native-messaging infrastructure
// is already INSTALLED on this machine: targetDetected's Dir-or-registry
// check, applied to every target in table order. Uninstall and Doctor build
// on this — they act on installed state, not on whether the browser itself
// merely exists (see DetectedBrowsers for that different question).
func Detected(all []Target, reg RegistryWriter) ([]Target, error) {
	return detectWith(all, reg, targetDetected)
}

// DetectedBrowsers returns the subset of all whose BROWSER is present on
// this machine, independent of whether this host has ever been installed
// into it. Install's candidate detection builds on this: keying it on
// Detected's own-host signal instead would mean a Windows target's
// RegistryPath — empty before that browser's very first install — can
// never be found, so plain `install` on a fresh machine could never
// bootstrap any browser (task report finding W1). Every POSIX target's
// signal is unchanged (Dir already reflects the browser's own presence —
// see targets_darwin.go / targets_linux.go); only Windows targets, which
// carry a distinct BrowserMarkerKey from RegistryPath, differ from
// Detected's result.
func DetectedBrowsers(all []Target, reg RegistryWriter) ([]Target, error) {
	return detectWith(all, reg, browserDetected)
}

// detectWith applies detect to every target in all, in table order,
// collecting the ones it reports present. Detected and DetectedBrowsers
// share this loop and differ only in which signal detect checks.
func detectWith(all []Target, reg RegistryWriter, detect func(Target, RegistryWriter) (bool, error)) ([]Target, error) {
	detected := make([]Target, 0, len(all))
	for _, t := range all {
		ok, err := detect(t, reg)
		if err != nil {
			return nil, fmt.Errorf("detecting %s: %w", t.ID, err)
		}
		if ok {
			detected = append(detected, t)
		}
	}
	return detected, nil
}

// targetDetected reports whether t's browser already has native-messaging
// infrastructure present, keyed on OUR HOST's own presence. A Windows
// target (RegistryPath set) checks that registry key; every other target
// checks its Dir. See Target's field docs and targets_windows.go for why
// Windows uses a different signal again for install-candidate detection
// (browserDetected).
func targetDetected(t Target, reg RegistryWriter) (bool, error) {
	if t.RegistryPath != "" {
		exists, err := reg.keyExists(t.RegistryPath)
		if err != nil {
			return false, fmt.Errorf("checking registry key %q: %w", t.RegistryPath, err)
		}
		return exists, nil
	}
	return dirExists(t.Dir)
}

// browserDetected reports whether t's BROWSER is present, keyed on the
// browser's OWN presence rather than our host's. A Windows target
// (BrowserMarkerKey set) checks that registry key; every other target
// checks its Dir, exactly like targetDetected — POSIX has only one signal
// to begin with (see targets_darwin.go / targets_linux.go).
func browserDetected(t Target, reg RegistryWriter) (bool, error) {
	if t.BrowserMarkerKey != "" {
		exists, err := reg.keyExists(t.BrowserMarkerKey)
		if err != nil {
			return false, fmt.Errorf("checking browser marker key %q: %w", t.BrowserMarkerKey, err)
		}
		return exists, nil
	}
	return dirExists(t.Dir)
}

// dirExists reports whether dir exists and is a directory, treating
// os.ErrNotExist as a clean "not detected" rather than an error.
func dirExists(dir string) (bool, error) {
	info, err := os.Stat(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("stat %q: %w", dir, err)
	}
	return info.IsDir(), nil
}

// ResolveCandidates is the scope logic Uninstall's caller uses to turn a
// --browsers flag into a concrete target list: a non-empty browsers value
// always wins, forcing those targets into scope even when this machine
// shows no installed-state signal for them. An empty browsers value falls
// back to Detected(all, reg) — our own host's installed state, the signal
// Uninstall needs. See ResolveInstallCandidates for Install's counterpart,
// which needs the browser-presence signal instead (task report finding
// W1).
func ResolveCandidates(all []Target, browsers string, reg RegistryWriter) ([]Target, error) {
	if strings.TrimSpace(browsers) != "" {
		return ResolveTargets(all, browsers)
	}
	return Detected(all, reg)
}

// ResolveInstallCandidates is ResolveCandidates' counterpart for Install:
// the same --browsers-flag-wins-else-detect logic, but falling back to
// DetectedBrowsers rather than Detected when browsers is empty. Install
// needs the browser-presence signal, not the installed-state signal
// ResolveCandidates gives Uninstall and Doctor — see DetectedBrowsers' doc
// for why conflating the two made plain `install` unable to bootstrap a
// browser's first-ever install (task report finding W1).
func ResolveInstallCandidates(all []Target, browsers string, reg RegistryWriter) ([]Target, error) {
	if strings.TrimSpace(browsers) != "" {
		return ResolveTargets(all, browsers)
	}
	return DetectedBrowsers(all, reg)
}

// ResolveTargets returns the subset of all named by the comma-separated
// ids in raw, in all's table order. An id with no matching Target is an
// error naming every unknown id and every known one, so a typo fails fast
// instead of silently installing to nothing.
func ResolveTargets(all []Target, raw string) ([]Target, error) {
	ids := splitBrowserIDs(raw)
	if len(ids) == 0 {
		return append([]Target(nil), all...), nil
	}

	byID := make(map[string]Target, len(all))
	for _, t := range all {
		byID[t.ID] = t
	}

	resolved := make([]Target, 0, len(ids))
	var unknown []string
	for _, id := range ids {
		t, ok := byID[id]
		if !ok {
			unknown = append(unknown, id)
			continue
		}
		resolved = append(resolved, t)
	}
	if len(unknown) > 0 {
		return nil, fmt.Errorf("setup: unknown browser id(s) %s (known: %s)",
			strings.Join(unknown, ", "), strings.Join(knownIDs(all), ", "))
	}
	return resolved, nil
}

// splitBrowserIDs trims and drops empty entries from raw's comma-separated
// list, so " chrome, ,dia " parses as ["chrome", "dia"].
func splitBrowserIDs(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	ids := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	return ids
}

// knownIDs lists every id in all, table order, for ResolveTargets' error
// message.
func knownIDs(all []Target) []string {
	ids := make([]string, 0, len(all))
	for _, t := range all {
		ids = append(ids, t.ID)
	}
	return ids
}

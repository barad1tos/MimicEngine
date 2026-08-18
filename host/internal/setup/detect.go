package setup

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// Detected returns the subset of all whose native-messaging infrastructure
// already exists on this machine: targetDetected's Dir-or-registry check,
// applied to every target in table order.
func Detected(all []Target, reg registryWriter) ([]Target, error) {
	detected := make([]Target, 0, len(all))
	for _, t := range all {
		ok, err := targetDetected(t, reg)
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
// infrastructure present. A Windows target (RegistryPath set) checks the
// registry key; every other target checks its Dir. See Target's field docs
// and targets_windows.go for why the two platforms use different signals.
func targetDetected(t Target, reg registryWriter) (bool, error) {
	if t.RegistryPath != "" {
		exists, err := reg.keyExists(t.RegistryPath)
		if err != nil {
			return false, fmt.Errorf("checking registry key %q: %w", t.RegistryPath, err)
		}
		return exists, nil
	}

	info, err := os.Stat(t.Dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("stat %q: %w", t.Dir, err)
	}
	return info.IsDir(), nil
}

// ResolveCandidates is the shared scope logic Install and Uninstall's
// callers use to turn a --browsers flag into a concrete target list: a
// non-empty browsers value always wins, forcing those targets into scope
// even when this machine shows no prior native-messaging activity for them
// (the dogfooding case: a freshly installed browser with nothing else
// registered against it yet has no infrastructure of its own to detect —
// see platformTargets' docs on both POSIX and Windows). An empty browsers
// value falls back to Detected(all, reg).
func ResolveCandidates(all []Target, browsers string, reg registryWriter) ([]Target, error) {
	if strings.TrimSpace(browsers) != "" {
		return ResolveTargets(all, browsers)
	}
	return Detected(all, reg)
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

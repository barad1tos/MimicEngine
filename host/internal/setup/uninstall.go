package setup

import (
	"errors"
	"fmt"
	"os"
)

// UninstallResult reports which targets Uninstall actually removed a
// manifest for, in the order it removed them.
type UninstallResult struct {
	Removed []Target
}

// Uninstall removes exactly what Install would have written for every
// target in candidates: its own registry value (for a Windows target), and
// the manifest file — but the file only once no OTHER target still claims
// it. all is the FULL target table (not just candidates): several Windows
// Chromium-family targets share one manifest file (see targets_windows.go),
// so removing chrome must not delete a file Brave/Edge/Vivaldi's own
// registry key still points at, even when they are not part of this call's
// candidates. Both removals are idempotent: a manifest file or registry
// value that is already absent is not an error, so uninstall stays safe to
// run more than once.
//
// A non-nil error from a removal failure partway through candidates does
// not invalidate the returned UninstallResult: it still reports the
// targets successfully removed before the failure, so callers can show
// exactly what was and wasn't touched.
func Uninstall(candidates []Target, all []Target, reg RegistryWriter) (UninstallResult, error) {
	removed := make([]Target, 0, len(candidates))
	for _, t := range candidates {
		if err := removeManifest(t, all, reg); err != nil {
			return UninstallResult{Removed: removed}, fmt.Errorf("uninstalling %s: %w", t.ID, err)
		}
		removed = append(removed, t)
	}
	return UninstallResult{Removed: removed}, nil
}

// removeManifest removes t's OWN registry value unconditionally (if it has
// one), then removes the manifest file only if no sibling target sharing
// t.Dir still has its own registry key present — see anySiblingRegistered.
// On every POSIX target, and any Windows target with no Dir-sharing
// sibling, that check always finds none, so the file is removed exactly as
// it was before reference counting existed.
func removeManifest(t Target, all []Target, reg RegistryWriter) error {
	if t.RegistryPath != "" {
		if err := reg.deleteValue(t.RegistryPath); err != nil {
			return fmt.Errorf("removing registry value under %q: %w", t.RegistryPath, err)
		}
	}

	claimed, err := anySiblingRegistered(t, all, reg)
	if err != nil {
		return err
	}
	if claimed {
		return nil
	}

	path := manifestPath(t)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("removing manifest %q: %w", path, err)
	}
	return nil
}

// anySiblingRegistered reports whether any OTHER target in all that writes
// its manifest to the same Dir as t (task report finding W4: several
// Windows Chromium-family targets share one manifest file) still has its
// own registry key present. A sibling with no RegistryPath (every POSIX
// target, where Dir is never shared across targets — see
// targets_darwin.go / targets_linux.go) never counts as still claiming the
// file this way.
func anySiblingRegistered(t Target, all []Target, reg RegistryWriter) (bool, error) {
	for _, sibling := range all {
		if sibling.ID == t.ID || sibling.Dir != t.Dir || sibling.RegistryPath == "" {
			continue
		}
		exists, err := reg.keyExists(sibling.RegistryPath)
		if err != nil {
			return false, fmt.Errorf("checking sibling registry key %q: %w", sibling.RegistryPath, err)
		}
		if exists {
			return true, nil
		}
	}
	return false, nil
}

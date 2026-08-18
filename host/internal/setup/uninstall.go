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
// target in candidates: the manifest file, and — for a Windows target —
// the registry value pointing at it. Both removals are idempotent: a
// manifest file or registry value that is already absent is not an error,
// so uninstall stays safe to run more than once.
func Uninstall(candidates []Target, reg registryWriter) (UninstallResult, error) {
	removed := make([]Target, 0, len(candidates))
	for _, t := range candidates {
		if err := removeManifest(t, reg); err != nil {
			return UninstallResult{Removed: removed}, fmt.Errorf("uninstalling %s: %w", t.ID, err)
		}
		removed = append(removed, t)
	}
	return UninstallResult{Removed: removed}, nil
}

// removeManifest deletes t's manifest file (if present) and, for a Windows
// target, its registry value.
func removeManifest(t Target, reg registryWriter) error {
	path := manifestPath(t)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("removing manifest %q: %w", path, err)
	}

	if t.RegistryPath == "" {
		return nil
	}
	if err := reg.deleteValue(t.RegistryPath, HostName); err != nil {
		return fmt.Errorf("removing registry value under %q: %w", t.RegistryPath, err)
	}
	return nil
}

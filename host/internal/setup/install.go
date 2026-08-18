package setup

import (
	"errors"
	"fmt"
	"os"
)

// InstallResult reports which targets Install actually wrote a manifest
// for, in the order it wrote them.
type InstallResult struct {
	Written []Target
}

// Install writes a native-messaging manifest (and, for a Windows target,
// the registry pointer to it) for every target in candidates, using opts to
// render each manifest's content.
//
// It fails fast, before writing anything, if candidates includes a
// Chromium-family target and opts.ExtensionID is empty — there is no
// default extension id to fall back to (see ManifestOptions.ExtensionID),
// so a partially-written install across several browsers is never a
// possible outcome of a missing flag.
func Install(candidates []Target, opts ManifestOptions, reg registryWriter) (InstallResult, error) {
	if opts.ExtensionID == "" && anyChromiumFamily(candidates) {
		return InstallResult{}, errors.New(
			"setup: --extension-id is required to install a Chromium-family manifest " +
				"(chrome, chromium, arc, brave, edge, vivaldi, dia)")
	}

	written := make([]Target, 0, len(candidates))
	for _, t := range candidates {
		if err := writeManifest(t, opts, reg); err != nil {
			return InstallResult{Written: written}, fmt.Errorf("installing %s: %w", t.ID, err)
		}
		written = append(written, t)
	}
	return InstallResult{Written: written}, nil
}

// writeManifest renders and writes t's manifest file, creating t.Dir if
// necessary, then — for a Windows target — points t.RegistryPath's
// HostName value at the file it just wrote.
func writeManifest(t Target, opts ManifestOptions, reg registryWriter) error {
	body, err := buildManifest(t.Family, opts)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(t.Dir, 0o755); err != nil {
		return fmt.Errorf("creating manifest directory %q: %w", t.Dir, err)
	}

	path := manifestPath(t)
	if err := os.WriteFile(path, body, 0o644); err != nil {
		return fmt.Errorf("writing manifest %q: %w", path, err)
	}

	if t.RegistryPath == "" {
		return nil
	}
	if err := reg.setValue(t.RegistryPath, HostName, path); err != nil {
		return fmt.Errorf("registering in %q: %w", t.RegistryPath, err)
	}
	return nil
}

// anyChromiumFamily reports whether targets contains at least one
// Chromium-family entry.
func anyChromiumFamily(targets []Target) bool {
	for _, t := range targets {
		if t.Family == Chromium {
			return true
		}
	}
	return false
}

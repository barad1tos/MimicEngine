package setup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInstallUninstall_RoundTripLeavesNoResidue(t *testing.T) {
	home := t.TempDir()
	targets := []Target{
		{ID: "chrome", Family: Chromium, Dir: filepath.Join(home, "chrome-nmh")},
		{
			ID: "chrome-win", Family: Chromium, Dir: filepath.Join(home, "win", "chromium"),
			RegistryPath: `Software\Google\Chrome\NativeMessagingHosts`,
		},
	}
	reg := newFakeRegistry()

	if _, err := Install(targets, ManifestOptions{ExtensionID: "x", BinaryPath: "/opt/host"}, reg); err != nil {
		t.Fatalf("Install: %v", err)
	}
	for _, tg := range targets {
		if _, err := os.Stat(manifestPath(tg)); err != nil {
			t.Fatalf("manifest for %s not written: %v", tg.ID, err)
		}
	}
	if _, present, _ := reg.value(targets[1].RegistryPath); !present {
		t.Fatal("registry value not written for the windows-style target")
	}

	result, err := Uninstall(targets, reg)
	if err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	if len(result.Removed) != len(targets) {
		t.Fatalf("Uninstall().Removed = %v, want %d entries", result.Removed, len(targets))
	}

	for _, tg := range targets {
		if _, err := os.Stat(manifestPath(tg)); !os.IsNotExist(err) {
			t.Fatalf("manifest for %s still present after uninstall: err=%v", tg.ID, err)
		}
	}
	if _, present, _ := reg.value(targets[1].RegistryPath); present {
		t.Fatal("registry value still present after uninstall")
	}
}

func TestUninstall_IdempotentOnMissingManifest(t *testing.T) {
	home := t.TempDir()
	target := Target{ID: "chrome", Family: Chromium, Dir: filepath.Join(home, "chrome-nmh")}

	// Never installed: the manifest file and its directory do not exist.
	result, err := Uninstall([]Target{target}, newFakeRegistry())
	if err != nil {
		t.Fatalf("Uninstall on a never-installed target: %v", err)
	}
	if len(result.Removed) != 1 {
		t.Fatalf("Uninstall().Removed = %v, want [chrome] (idempotent, not an error)", result.Removed)
	}
}

func TestUninstall_RemoveManifestErrorPropagates(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "chrome-nmh")
	// The manifest "file" path is actually a non-empty directory here, so
	// os.Remove fails with something other than ErrNotExist.
	manifestAsDir := filepath.Join(dir, HostName+".json")
	if err := os.MkdirAll(manifestAsDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(manifestAsDir, "occupied"), []byte("x"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	target := Target{ID: "chrome", Family: Chromium, Dir: dir}
	_, err := Uninstall([]Target{target}, newFakeRegistry())
	if err == nil {
		t.Fatal("Uninstall() = nil error, want an error when the manifest path is a non-empty directory")
	}
}

func TestUninstall_DeleteValueErrorPropagates(t *testing.T) {
	first := Target{ID: "firefox", Family: Firefox, Dir: t.TempDir()}
	second := Target{
		ID: "chrome", Family: Chromium, Dir: t.TempDir(),
		RegistryPath: `Software\Google\Chrome\NativeMessagingHosts`,
	}

	result, err := Uninstall([]Target{first, second}, erroringRegistry{})
	if err == nil {
		t.Fatal("Uninstall() = nil error, want an error when the registry delete fails")
	}
	if len(result.Removed) != 1 {
		t.Fatalf("Uninstall().Removed = %v, want exactly one entry ([firefox])", result.Removed)
	}
	if result.Removed[0].ID != "firefox" {
		t.Fatalf("Uninstall().Removed = %v, want [firefox] (the target removed before the failing one)", result.Removed)
	}
}

func TestUninstall_IdempotentOnMissingRegistryValue(t *testing.T) {
	target := Target{
		ID: "chrome", Family: Chromium, Dir: t.TempDir(),
		RegistryPath: `Software\Google\Chrome\NativeMessagingHosts`,
	}
	// Empty fakeRegistry: no value was ever set for this target.
	if _, err := Uninstall([]Target{target}, newFakeRegistry()); err != nil {
		t.Fatalf("Uninstall on a target with no registry value: %v", err)
	}
}

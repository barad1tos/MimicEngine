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

	result, err := Uninstall(targets, targets, reg)
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
	result, err := Uninstall([]Target{target}, []Target{target}, newFakeRegistry())
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
	_, err := Uninstall([]Target{target}, []Target{target}, newFakeRegistry())
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

	result, err := Uninstall([]Target{first, second}, []Target{first, second}, erroringRegistry{})
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

// TestUninstall_SharedManifestSurvivesUntilLastSibling pins task report
// finding W4: several Windows Chromium-family targets write to the same
// Dir (and therefore the same manifest file — see targets_windows.go).
// Uninstalling one of them must not delete a file a sibling's own registry
// key still points at; only removing the LAST sibling's key may delete it.
func TestUninstall_SharedManifestSurvivesUntilLastSibling(t *testing.T) {
	sharedDir := t.TempDir()
	chrome := Target{
		ID: "chrome", Family: Chromium, Dir: sharedDir,
		RegistryPath: `Software\Google\Chrome\NativeMessagingHosts\` + HostName,
	}
	brave := Target{
		ID: "brave", Family: Chromium, Dir: sharedDir,
		RegistryPath: `Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\` + HostName,
	}
	all := []Target{chrome, brave}
	reg := newFakeRegistry()

	if _, err := Install(all, ManifestOptions{ExtensionID: "x", BinaryPath: "/opt/host"}, reg); err != nil {
		t.Fatalf("Install: %v", err)
	}
	sharedManifest := manifestPath(chrome)
	if sharedManifest != manifestPath(brave) {
		t.Fatalf("test setup invalid: chrome and brave must share one manifest path, got %q and %q", sharedManifest, manifestPath(brave))
	}
	if _, err := os.Stat(sharedManifest); err != nil {
		t.Fatalf("setup precondition failed, shared manifest missing: %v", err)
	}

	if _, err := Uninstall([]Target{chrome}, all, reg); err != nil {
		t.Fatalf("Uninstall(chrome): %v", err)
	}
	if _, err := os.Stat(sharedManifest); err != nil {
		t.Fatalf("shared manifest removed after uninstalling chrome alone, want it to survive while brave's key remains: %v", err)
	}
	if _, present, _ := reg.value(chrome.RegistryPath); present {
		t.Fatal("chrome's own registry key still present after its uninstall")
	}
	if _, present, _ := reg.value(brave.RegistryPath); !present {
		t.Fatal("brave's registry key was removed by uninstalling chrome — reference counting must only touch the requested target's key")
	}

	if _, err := Uninstall([]Target{brave}, all, reg); err != nil {
		t.Fatalf("Uninstall(brave): %v", err)
	}
	if _, err := os.Stat(sharedManifest); !os.IsNotExist(err) {
		t.Fatalf("shared manifest still present after uninstalling the last sibling (brave): err=%v", err)
	}
}

func TestUninstall_IdempotentOnMissingRegistryValue(t *testing.T) {
	target := Target{
		ID: "chrome", Family: Chromium, Dir: t.TempDir(),
		RegistryPath: `Software\Google\Chrome\NativeMessagingHosts`,
	}
	// Empty fakeRegistry: no value was ever set for this target.
	if _, err := Uninstall([]Target{target}, []Target{target}, newFakeRegistry()); err != nil {
		t.Fatalf("Uninstall on a target with no registry value: %v", err)
	}
}

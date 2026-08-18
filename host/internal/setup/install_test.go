package setup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testExtensionID is a syntactically valid 32-character Chromium extension
// id (the alphabet is a-p) built from a repeating pair rather than a
// dictionary-shaped string, so spellcheck inspections don't flag it as a
// typo.
var testExtensionID = strings.Repeat("ab", 16)

func TestInstall_WritesGoldenChromiumManifest(t *testing.T) {
	home := t.TempDir()
	target := Target{ID: "chrome", Name: "Google Chrome", Family: Chromium, Dir: filepath.Join(home, "chrome-nmh")}

	result, err := Install([]Target{target}, ManifestOptions{
		ExtensionID: testExtensionID,
		BinaryPath:  "/opt/mimicengine-host",
	}, newFakeRegistry())
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if len(result.Written) != 1 || result.Written[0].ID != "chrome" {
		t.Fatalf("Install().Written = %v, want [chrome]", result.Written)
	}

	body, err := os.ReadFile(filepath.Join(target.Dir, HostName+".json"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var m chromiumManifest
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if m.Name != HostName || m.Path != "/opt/mimicengine-host" || m.Type != "stdio" {
		t.Fatalf("manifest = %+v, want the golden chromium shape", m)
	}
	if len(m.AllowedOrigins) != 1 || m.AllowedOrigins[0] != "chrome-extension://"+testExtensionID+"/" {
		t.Fatalf("AllowedOrigins = %v", m.AllowedOrigins)
	}
}

func TestInstall_WritesGoldenFirefoxManifest(t *testing.T) {
	home := t.TempDir()
	target := Target{ID: "firefox", Name: "Firefox", Family: Firefox, Dir: filepath.Join(home, "firefox-nmh")}

	_, err := Install([]Target{target}, ManifestOptions{BinaryPath: "/opt/mimicengine-host"}, newFakeRegistry())
	if err != nil {
		t.Fatalf("Install: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(target.Dir, HostName+".json"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var m firefoxManifest
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(m.AllowedExtensions) != 1 || m.AllowedExtensions[0] != DefaultGeckoID {
		t.Fatalf("AllowedExtensions = %v, want [%q]", m.AllowedExtensions, DefaultGeckoID)
	}
}

func TestInstall_WindowsTargetRegistersManifestPath(t *testing.T) {
	home := t.TempDir()
	target := Target{
		ID: "chrome", Name: "Google Chrome", Family: Chromium,
		Dir:          filepath.Join(home, "MimicEngine", "chromium"),
		RegistryPath: `Software\Google\Chrome\NativeMessagingHosts`,
	}
	reg := newFakeRegistry()

	result, err := Install([]Target{target}, ManifestOptions{
		ExtensionID: "x", BinaryPath: "C:\\mimicengine-host.exe",
	}, reg)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if len(result.Written) != 1 {
		t.Fatalf("Install().Written = %v, want one entry", result.Written)
	}

	wantPath := filepath.Join(target.Dir, HostName+".json")
	data, present, err := reg.value(target.RegistryPath, HostName)
	if err != nil {
		t.Fatalf("value: %v", err)
	}
	if !present || data != wantPath {
		t.Fatalf("registry value = (%q, %v), want (%q, true)", data, present, wantPath)
	}
}

func TestInstall_RequiresExtensionIDForChromiumFamily(t *testing.T) {
	home := t.TempDir()
	target := Target{ID: "chrome", Family: Chromium, Dir: filepath.Join(home, "chrome-nmh")}

	_, err := Install([]Target{target}, ManifestOptions{BinaryPath: "/opt/mimicengine-host"}, newFakeRegistry())
	if err == nil {
		t.Fatal("Install() = nil error, want an error for a missing --extension-id")
	}
	if _, statErr := os.Stat(target.Dir); statErr == nil {
		t.Fatal("Install() created the manifest directory despite failing validation — should fail before writing anything")
	}
}

func TestInstall_FirefoxOnlyDoesNotRequireExtensionID(t *testing.T) {
	home := t.TempDir()
	target := Target{ID: "firefox", Family: Firefox, Dir: filepath.Join(home, "firefox-nmh")}

	_, err := Install([]Target{target}, ManifestOptions{BinaryPath: "/opt/mimicengine-host"}, newFakeRegistry())
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
}

func TestInstall_MkdirAllFailurePropagates(t *testing.T) {
	home := t.TempDir()
	blocker := filepath.Join(home, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	// Dir traverses through a regular file, so MkdirAll cannot create it.
	target := Target{ID: "chrome", Family: Chromium, Dir: filepath.Join(blocker, "NativeMessagingHosts")}

	_, err := Install([]Target{target}, ManifestOptions{ExtensionID: "x", BinaryPath: "/bin/host"}, newFakeRegistry())
	if err == nil {
		t.Fatal("Install() = nil error, want an error when the manifest directory cannot be created")
	}
}

func TestInstall_RegistrySetValueFailurePropagates(t *testing.T) {
	first := Target{ID: "firefox", Family: Firefox, Dir: t.TempDir()}
	second := Target{
		ID: "chrome", Family: Chromium, Dir: t.TempDir(),
		RegistryPath: `Software\Google\Chrome\NativeMessagingHosts`,
	}

	result, err := Install([]Target{first, second}, ManifestOptions{ExtensionID: "x", BinaryPath: "/bin/host"}, erroringRegistry{})
	if err == nil {
		t.Fatal("Install() = nil error, want an error when the registry write fails")
	}
	if len(result.Written) != 1 {
		t.Fatalf("Install().Written = %v, want exactly one entry ([firefox])", result.Written)
	}
	if result.Written[0].ID != "firefox" {
		t.Fatalf("Install().Written = %v, want [firefox] (the target written before the failing one)", result.Written)
	}
}

func TestInstall_EmptyCandidatesIsANoOp(t *testing.T) {
	result, err := Install(nil, ManifestOptions{BinaryPath: "/opt/mimicengine-host"}, newFakeRegistry())
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if len(result.Written) != 0 {
		t.Fatalf("Install(nil).Written = %v, want empty", result.Written)
	}
}

package setup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDoctorReport_NotInstalled(t *testing.T) {
	target := Target{ID: "chrome", Family: Chromium, Dir: t.TempDir()}
	reports := DoctorReport([]Target{target}, newFakeRegistry())

	if len(reports) != 1 || reports[0].Status != StatusNotInstalled {
		t.Fatalf("DoctorReport() = %+v, want a single StatusNotInstalled entry", reports)
	}
}

func TestDoctorReport_GreenCase(t *testing.T) {
	home := t.TempDir()
	binaryPath := filepath.Join(home, "mimicengine-host")
	if err := os.WriteFile(binaryPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	target := Target{ID: "chrome", Family: Chromium, Dir: filepath.Join(home, "chrome-nmh")}

	if _, err := Install([]Target{target}, ManifestOptions{ExtensionID: "abc", BinaryPath: binaryPath}, newFakeRegistry()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	reports := DoctorReport([]Target{target}, newFakeRegistry())
	if len(reports) != 1 || reports[0].Status != StatusOK {
		t.Fatalf("DoctorReport() = %+v, want StatusOK", reports)
	}
}

func TestDoctorReport_MalformedManifest(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "chrome-nmh")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, HostName+".json"), []byte("{not json"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	target := Target{ID: "chrome", Family: Chromium, Dir: dir}

	reports := DoctorReport([]Target{target}, newFakeRegistry())
	if len(reports) != 1 || reports[0].Status != StatusFail {
		t.Fatalf("DoctorReport() = %+v, want StatusFail for a malformed manifest", reports)
	}
}

func TestDoctorReport_MissingBinary(t *testing.T) {
	home := t.TempDir()
	target := Target{ID: "chrome", Family: Chromium, Dir: filepath.Join(home, "chrome-nmh")}

	missingBinary := filepath.Join(home, "does-not-exist")
	if _, err := Install([]Target{target}, ManifestOptions{ExtensionID: "abc", BinaryPath: missingBinary}, newFakeRegistry()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	reports := DoctorReport([]Target{target}, newFakeRegistry())
	if len(reports) != 1 || reports[0].Status != StatusFail {
		t.Fatalf("DoctorReport() = %+v, want StatusFail for a missing binary", reports)
	}
}

func TestDoctorReport_NonExecutableBinary(t *testing.T) {
	home := t.TempDir()
	binaryPath := filepath.Join(home, "mimicengine-host")
	if err := os.WriteFile(binaryPath, []byte("not executable"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	target := Target{ID: "chrome", Family: Chromium, Dir: filepath.Join(home, "chrome-nmh")}

	if _, err := Install([]Target{target}, ManifestOptions{ExtensionID: "abc", BinaryPath: binaryPath}, newFakeRegistry()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	reports := DoctorReport([]Target{target}, newFakeRegistry())
	if len(reports) != 1 || reports[0].Status != StatusFail {
		t.Fatalf("DoctorReport() = %+v, want StatusFail for a non-executable binary", reports)
	}
}

func TestDoctorReport_UnknownExtensionID(t *testing.T) {
	home := t.TempDir()
	binaryPath := filepath.Join(home, "mimicengine-host")
	if err := os.WriteFile(binaryPath, []byte("x"), 0o755); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	dir := filepath.Join(home, "chrome-nmh")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	// A manifest with no allowed_origins entry at all — the pre-T6 "no
	// extension id known yet" shape doctor must report as "unknown", not
	// crash on.
	body := []byte(`{"name":"` + HostName + `","description":"d","path":"` + binaryPath + `","type":"stdio","allowed_origins":[]}`)
	if err := os.WriteFile(filepath.Join(dir, HostName+".json"), body, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	target := Target{ID: "chrome", Family: Chromium, Dir: dir}

	reports := DoctorReport([]Target{target}, newFakeRegistry())
	if len(reports) != 1 || reports[0].Status != StatusFail {
		t.Fatalf("DoctorReport() = %+v, want StatusFail", reports)
	}
	if reports[0].Detail != "extension id: unknown" {
		t.Fatalf("Detail = %q, want the \"unknown\" message", reports[0].Detail)
	}
}

func TestDoctorReport_WindowsRegistryMismatch(t *testing.T) {
	home := t.TempDir()
	binaryPath := filepath.Join(home, "mimicengine-host.exe")
	if err := os.WriteFile(binaryPath, []byte("x"), 0o755); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	target := Target{
		ID: "chrome", Family: Chromium, Dir: filepath.Join(home, "chromium"),
		RegistryPath: `Software\Google\Chrome\NativeMessagingHosts`,
	}
	reg := newFakeRegistry()
	if _, err := Install([]Target{target}, ManifestOptions{ExtensionID: "abc", BinaryPath: binaryPath}, reg); err != nil {
		t.Fatalf("Install: %v", err)
	}

	// Simulate drift: something else rewrote the registry value.
	if err := reg.setValue(target.RegistryPath, HostName, "C:\\elsewhere.json"); err != nil {
		t.Fatalf("setValue: %v", err)
	}

	reports := DoctorReport([]Target{target}, reg)
	if len(reports) != 1 || reports[0].Status != StatusFail {
		t.Fatalf("DoctorReport() = %+v, want StatusFail for a registry/manifest mismatch", reports)
	}
}

func TestDoctorReport_RegistryValueReadErrorPropagates(t *testing.T) {
	home := t.TempDir()
	binaryPath := filepath.Join(home, "mimicengine-host")
	if err := os.WriteFile(binaryPath, []byte("x"), 0o755); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	target := Target{
		ID: "chrome", Family: Chromium, Dir: filepath.Join(home, "chromium"),
		RegistryPath: `Software\Google\Chrome\NativeMessagingHosts`,
	}
	if _, err := Install([]Target{target}, ManifestOptions{ExtensionID: "abc", BinaryPath: binaryPath}, newFakeRegistry()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	reports := DoctorReport([]Target{target}, erroringRegistry{})
	if len(reports) != 1 || reports[0].Status != StatusFail {
		t.Fatalf("DoctorReport() = %+v, want StatusFail when the registry read fails", reports)
	}
}

func TestParseManifest_FirefoxMalformedJSON(t *testing.T) {
	if _, _, err := parseManifest(Firefox, []byte("{not json")); err == nil {
		t.Fatal("parseManifest() = nil error, want an error for malformed JSON")
	}
}

func TestParseManifest_FirefoxMissingPath(t *testing.T) {
	if _, _, err := parseManifest(Firefox, []byte(`{"name":"x"}`)); err == nil {
		t.Fatal("parseManifest() = nil error, want an error for a missing \"path\"")
	}
}

func TestParseManifest_UnknownFamily(t *testing.T) {
	if _, _, err := parseManifest(Family(99), []byte("{}")); err == nil {
		t.Fatal("parseManifest() = nil error, want an error for an unknown family")
	}
}

func TestExtractChromiumExtensionID(t *testing.T) {
	tests := []struct {
		name    string
		origins []string
		want    string
	}{
		{"empty list", nil, ""},
		{"valid origin", []string{"chrome-extension://abc/"}, "abc"},
		{"missing prefix", []string{"https://abc/"}, ""},
		{"missing trailing slash", []string{"chrome-extension://abc"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := extractChromiumExtensionID(tt.origins); got != tt.want {
				t.Errorf("extractChromiumExtensionID(%v) = %q, want %q", tt.origins, got, tt.want)
			}
		})
	}
}

func TestCheckExecutable_MissingPath(t *testing.T) {
	if err := checkExecutable(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("checkExecutable() = nil error, want an error for a missing path")
	}
}

func TestCheckExecutable_IsDirectory(t *testing.T) {
	if err := checkExecutable(t.TempDir()); err == nil {
		t.Fatal("checkExecutable() = nil error, want an error when the path is a directory")
	}
}

func TestDoctorReport_MultipleTargetsIndependent(t *testing.T) {
	home := t.TempDir()
	binaryPath := filepath.Join(home, "mimicengine-host")
	if err := os.WriteFile(binaryPath, []byte("x"), 0o755); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	installed := Target{ID: "chrome", Family: Chromium, Dir: filepath.Join(home, "chrome-nmh")}
	notInstalled := Target{ID: "firefox", Family: Firefox, Dir: filepath.Join(home, "firefox-nmh")}

	if _, err := Install([]Target{installed}, ManifestOptions{ExtensionID: "abc", BinaryPath: binaryPath}, newFakeRegistry()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	reports := DoctorReport([]Target{installed, notInstalled}, newFakeRegistry())
	if len(reports) != 2 {
		t.Fatalf("DoctorReport() returned %d reports, want 2", len(reports))
	}
	if reports[0].Status != StatusOK {
		t.Errorf("reports[0] (%s) Status = %v, want StatusOK", reports[0].Target.ID, reports[0].Status)
	}
	if reports[1].Status != StatusNotInstalled {
		t.Errorf("reports[1] (%s) Status = %v, want StatusNotInstalled", reports[1].Target.ID, reports[1].Status)
	}
}

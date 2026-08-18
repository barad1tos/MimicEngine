package setup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetected_PosixDirPresence(t *testing.T) {
	home := t.TempDir()
	chromeDir := filepath.Join(home, "chrome-nmh")
	if err := os.MkdirAll(chromeDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	all := []Target{
		{ID: "chrome", Name: "Chrome", Family: Chromium, Dir: chromeDir},
		{ID: "firefox", Name: "Firefox", Family: Firefox, Dir: filepath.Join(home, "firefox-nmh")},
	}

	detected, err := Detected(all, newFakeRegistry())
	if err != nil {
		t.Fatalf("Detected: %v", err)
	}
	if len(detected) != 1 || detected[0].ID != "chrome" {
		t.Fatalf("Detected() = %v, want exactly [chrome]", detected)
	}
}

func TestDetected_WindowsRegistryPresence(t *testing.T) {
	reg := newFakeRegistry()
	if err := reg.setValue(`Software\Google\Chrome\NativeMessagingHosts`, "some-other-host", "C:\\other.json"); err != nil {
		t.Fatalf("setValue: %v", err)
	}

	all := []Target{
		{ID: "chrome", Name: "Chrome", Family: Chromium, RegistryPath: `Software\Google\Chrome\NativeMessagingHosts`},
		{ID: "firefox", Name: "Firefox", Family: Firefox, RegistryPath: `Software\Mozilla\NativeMessagingHosts`},
	}

	detected, err := Detected(all, reg)
	if err != nil {
		t.Fatalf("Detected: %v", err)
	}
	if len(detected) != 1 || detected[0].ID != "chrome" {
		t.Fatalf("Detected() = %v, want exactly [chrome] (key exists from another app's value)", detected)
	}
}

func TestDetected_StatErrorPropagates(t *testing.T) {
	home := t.TempDir()
	// A regular file where a directory is expected under it: Stat succeeds
	// but the target's Dir traverses through a non-directory, forcing a
	// real filesystem error rather than the "not exist" no-op path.
	blocker := filepath.Join(home, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	all := []Target{
		{ID: "chrome", Name: "Chrome", Family: Chromium, Dir: filepath.Join(blocker, "NativeMessagingHosts")},
	}

	if _, err := Detected(all, newFakeRegistry()); err == nil {
		t.Fatal("Detected() = nil error, want an error when Dir traverses a non-directory")
	}
}

func TestDetected_RegistryErrorPropagates(t *testing.T) {
	all := []Target{{ID: "chrome", RegistryPath: `Software\Google\Chrome\NativeMessagingHosts`}}

	_, err := Detected(all, erroringRegistry{keyExistsErr: errBoom})
	if err == nil {
		t.Fatal("Detected() = nil error, want an error when keyExists fails")
	}
}

func TestResolveTargets_Filters(t *testing.T) {
	all := []Target{
		{ID: "chrome", Name: "Chrome"},
		{ID: "firefox", Name: "Firefox"},
		{ID: "dia", Name: "Dia"},
	}

	got, err := ResolveTargets(all, " chrome, dia ")
	if err != nil {
		t.Fatalf("ResolveTargets: %v", err)
	}
	if len(got) != 2 || got[0].ID != "chrome" || got[1].ID != "dia" {
		t.Fatalf("ResolveTargets() = %v, want [chrome dia] in table order", got)
	}
}

func TestResolveTargets_EmptyReturnsAll(t *testing.T) {
	all := []Target{{ID: "chrome"}, {ID: "firefox"}}
	got, err := ResolveTargets(all, "")
	if err != nil {
		t.Fatalf("ResolveTargets: %v", err)
	}
	if len(got) != len(all) {
		t.Fatalf("ResolveTargets(\"\") = %v, want every target", got)
	}
}

func TestResolveTargets_UnknownIDErrors(t *testing.T) {
	all := []Target{{ID: "chrome"}, {ID: "firefox"}}
	_, err := ResolveTargets(all, "chrome,bogus")
	if err == nil {
		t.Fatal("ResolveTargets() = nil error, want an error for an unknown id")
	}
}

func TestResolveCandidates_BrowsersFlagBypassesDetection(t *testing.T) {
	home := t.TempDir() // nothing detected: neither Dir exists
	all := []Target{
		{ID: "dia", Name: "Dia", Family: Chromium, Dir: filepath.Join(home, "Dia")},
		{ID: "firefox", Name: "Firefox", Family: Firefox, Dir: filepath.Join(home, "Mozilla")},
	}

	got, err := ResolveCandidates(all, "dia", newFakeRegistry())
	if err != nil {
		t.Fatalf("ResolveCandidates: %v", err)
	}
	if len(got) != 1 || got[0].ID != "dia" {
		t.Fatalf("ResolveCandidates() = %v, want [dia] even though its Dir does not exist yet", got)
	}
}

func TestResolveCandidates_EmptyFallsBackToDetected(t *testing.T) {
	home := t.TempDir()
	diaDir := filepath.Join(home, "Dia")
	if err := os.MkdirAll(diaDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	all := []Target{
		{ID: "dia", Name: "Dia", Family: Chromium, Dir: diaDir},
		{ID: "firefox", Name: "Firefox", Family: Firefox, Dir: filepath.Join(home, "Mozilla")},
	}

	got, err := ResolveCandidates(all, "", newFakeRegistry())
	if err != nil {
		t.Fatalf("ResolveCandidates: %v", err)
	}
	if len(got) != 1 || got[0].ID != "dia" {
		t.Fatalf("ResolveCandidates(\"\") = %v, want exactly the detected [dia]", got)
	}
}

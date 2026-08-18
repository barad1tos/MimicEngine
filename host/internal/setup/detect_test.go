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
	// RegistryPath is the FULL host-specific key (see targets_windows.go),
	// so — unlike the POSIX shared-directory signal — only a prior install
	// of THIS host can make it exist; that's what's simulated here.
	chromeKey := `Software\Google\Chrome\NativeMessagingHosts\` + HostName
	reg := newFakeRegistry()
	if err := reg.setValue(chromeKey, "C:\\mimicengine-host.json"); err != nil {
		t.Fatalf("setValue: %v", err)
	}

	all := []Target{
		{ID: "chrome", Name: "Chrome", Family: Chromium, RegistryPath: chromeKey},
		{ID: "firefox", Name: "Firefox", Family: Firefox, RegistryPath: `Software\Mozilla\NativeMessagingHosts\` + HostName},
	}

	detected, err := Detected(all, reg)
	if err != nil {
		t.Fatalf("Detected: %v", err)
	}
	if len(detected) != 1 || detected[0].ID != "chrome" {
		t.Fatalf("Detected() = %v, want exactly [chrome] (its own host key already exists)", detected)
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

// TestDetectedBrowsers_WindowsMarkerKeyPresence pins task report finding
// W1's fix: install-candidate detection must key on the BROWSER's own
// marker key, not our host's RegistryPath (which is absent before the very
// first install and would otherwise make bootstrap impossible). Only the
// marker key is present here — RegistryPath is empty, simulating a browser
// that exists but has never had this host installed into it.
func TestDetectedBrowsers_WindowsMarkerKeyPresence(t *testing.T) {
	markerKey := `Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe`
	reg := newFakeRegistry()
	if err := reg.setValue(markerKey, `C:\Program Files\Google\Chrome\Application\chrome.exe`); err != nil {
		t.Fatalf("setValue: %v", err)
	}

	all := []Target{
		{ID: "chrome", Name: "Chrome", Family: Chromium, BrowserMarkerKey: markerKey},
		{ID: "firefox", Name: "Firefox", Family: Firefox, BrowserMarkerKey: `Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe`},
	}

	detected, err := DetectedBrowsers(all, reg)
	if err != nil {
		t.Fatalf("DetectedBrowsers: %v", err)
	}
	if len(detected) != 1 || detected[0].ID != "chrome" {
		t.Fatalf("DetectedBrowsers() = %v, want exactly [chrome] (its marker key exists even though RegistryPath does not)", detected)
	}
}

// TestDetectedBrowsers_NoMarkerKeyNotDetected is the negative case: an empty
// fake registry (no marker key ever set) must report nothing detected, not
// silently succeed.
func TestDetectedBrowsers_NoMarkerKeyNotDetected(t *testing.T) {
	all := []Target{
		{ID: "chrome", Name: "Chrome", Family: Chromium, BrowserMarkerKey: `Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe`},
	}

	detected, err := DetectedBrowsers(all, newFakeRegistry())
	if err != nil {
		t.Fatalf("DetectedBrowsers: %v", err)
	}
	if len(detected) != 0 {
		t.Fatalf("DetectedBrowsers() = %v, want none (marker key never set)", detected)
	}
}

// TestDetected_IgnoresBrowserMarkerKey proves the separation W1 introduced
// holds in the other direction too: Detected (Uninstall/Doctor's installed-
// state signal) must NOT treat a present BrowserMarkerKey as "installed"
// when RegistryPath — our own host's key — is absent. Conflating the two
// would make uninstall target a browser this host was never actually
// registered with.
func TestDetected_IgnoresBrowserMarkerKey(t *testing.T) {
	markerKey := `Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe`
	reg := newFakeRegistry()
	if err := reg.setValue(markerKey, `C:\chrome.exe`); err != nil {
		t.Fatalf("setValue: %v", err)
	}

	all := []Target{
		{ID: "chrome", Name: "Chrome", Family: Chromium, BrowserMarkerKey: markerKey},
	}

	detected, err := Detected(all, reg)
	if err != nil {
		t.Fatalf("Detected: %v", err)
	}
	if len(detected) != 0 {
		t.Fatalf("Detected() = %v, want none — RegistryPath (our host's own key) is empty, BrowserMarkerKey must not substitute for it", detected)
	}
}

// TestResolveInstallCandidates_EmptyFallsBackToDetectedBrowsers is
// ResolveInstallCandidates' analogue of
// TestResolveCandidates_EmptyFallsBackToDetected: an empty --browsers value
// falls back to DetectedBrowsers, not Detected.
func TestResolveInstallCandidates_EmptyFallsBackToDetectedBrowsers(t *testing.T) {
	markerKey := `Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe`
	reg := newFakeRegistry()
	if err := reg.setValue(markerKey, `C:\chrome.exe`); err != nil {
		t.Fatalf("setValue: %v", err)
	}

	all := []Target{
		{ID: "chrome", Name: "Chrome", Family: Chromium, BrowserMarkerKey: markerKey},
		{ID: "firefox", Name: "Firefox", Family: Firefox, BrowserMarkerKey: `Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe`},
	}

	got, err := ResolveInstallCandidates(all, "", reg)
	if err != nil {
		t.Fatalf("ResolveInstallCandidates: %v", err)
	}
	if len(got) != 1 || got[0].ID != "chrome" {
		t.Fatalf("ResolveInstallCandidates(\"\") = %v, want exactly [chrome] (the browser with a marker key)", got)
	}
}

// TestResolveInstallCandidates_BrowsersFlagBypassesDetection mirrors
// TestResolveCandidates_BrowsersFlagBypassesDetection for the install
// variant: an explicit --browsers value wins regardless of detection.
func TestResolveInstallCandidates_BrowsersFlagBypassesDetection(t *testing.T) {
	all := []Target{
		{ID: "chrome", Name: "Chrome", Family: Chromium},
		{ID: "firefox", Name: "Firefox", Family: Firefox},
	}

	got, err := ResolveInstallCandidates(all, "chrome", newFakeRegistry())
	if err != nil {
		t.Fatalf("ResolveInstallCandidates: %v", err)
	}
	if len(got) != 1 || got[0].ID != "chrome" {
		t.Fatalf("ResolveInstallCandidates() = %v, want [chrome] even though nothing is detected", got)
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

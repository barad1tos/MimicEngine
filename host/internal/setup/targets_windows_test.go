//go:build windows

package setup

import "testing"

// TestPlatformTargets_Windows_RegistryPathsMatchBrowserContract pins the
// EXACT registry key shape Chrome/Firefox actually read a native-messaging
// host from: HKCU\...\NativeMessagingHosts\<host name>, whose default value
// holds the manifest path — not the shared parent key a prior
// implementation wrote a named value under (task-4-report.md's Fix round 3,
// finding C2: getting this string wrong means the browser can never find
// the host at all). Enforcing the literal string here, rather than just a
// prefix or suffix check, is what makes the OS contract fail loudly on any
// future accidental edit.
func TestPlatformTargets_Windows_RegistryPathsMatchBrowserContract(t *testing.T) {
	got := platformTargetsByID(t)

	want := map[string]string{
		"chrome":   `Software\Google\Chrome\NativeMessagingHosts\` + HostName,
		"chromium": `Software\Chromium\NativeMessagingHosts\` + HostName,
		"brave":    `Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\` + HostName,
		"edge":     `Software\Microsoft\Edge\NativeMessagingHosts\` + HostName,
		"vivaldi":  `Software\Vivaldi\NativeMessagingHosts\` + HostName,
		"firefox":  `Software\Mozilla\NativeMessagingHosts\` + HostName,
	}

	// The exact key Chrome/Firefox read — not just a prefix/suffix match, so
	// a future accidental edit fails loudly.
	assertTargetField(t, got, want, "RegistryPath", func(tg Target) string { return tg.RegistryPath })
}

// platformTargetsByID runs platformTargets against a fresh temp home and
// indexes the result by ID, the lookup shape every test in this file that
// checks individual targets' fields needs.
func platformTargetsByID(t *testing.T) map[string]Target {
	t.Helper()

	targets := platformTargets(t.TempDir())
	byID := make(map[string]Target, len(targets))
	for _, tg := range targets {
		byID[tg.ID] = tg
	}
	return byID
}

// assertTargetField checks field(tg) against every id/value pair in want,
// failing loudly on a missing id or a mismatched value — the shared
// assertion loop every field-pinning test in this file needs.
func assertTargetField(t *testing.T, got map[string]Target, want map[string]string, fieldName string, field func(Target) string) {
	t.Helper()

	for id, wantValue := range want {
		tg, ok := got[id]
		if !ok {
			t.Errorf("platformTargets(home) is missing id %q", id)
			continue
		}
		if got := field(tg); got != wantValue {
			t.Errorf("%s.%s = %q, want %q", id, fieldName, got, wantValue)
		}
	}
}

// TestPlatformTargets_Windows_BrowserMarkerKeysAreAppPaths pins task report
// finding W1's fix: every Chromium-family target but "chromium" (which has
// no verified installer marker — see platformTargets' doc) carries a
// BrowserMarkerKey under the standard Windows "App Paths" registration
// convention, distinct from RegistryPath (our own host's key).
func TestPlatformTargets_Windows_BrowserMarkerKeysAreAppPaths(t *testing.T) {
	got := platformTargetsByID(t)

	const appPaths = `Software\Microsoft\Windows\CurrentVersion\App Paths\`
	want := map[string]string{
		"chrome":   appPaths + "chrome.exe",
		"brave":    appPaths + "brave.exe",
		"edge":     appPaths + "msedge.exe",
		"vivaldi":  appPaths + "vivaldi.exe",
		"firefox":  appPaths + "firefox.exe",
		"chromium": "", // no verified App Paths entry; documented gap
	}

	assertTargetField(t, got, want, "BrowserMarkerKey", func(tg Target) string { return tg.BrowserMarkerKey })

	for id, tg := range got {
		if tg.BrowserMarkerKey != "" && tg.BrowserMarkerKey == tg.RegistryPath {
			t.Errorf("%s.BrowserMarkerKey must not equal RegistryPath — they answer different questions (browser presence vs our host's own installed state)", id)
		}
	}
}

// TestPlatformTargets_Windows_ExportedWrapperMatchesInternal mirrors the
// darwin/POSIX equivalent (targets_darwin_test.go): proves the exported
// PlatformTargets wrapper actually delegates to platformTargets rather
// than, say, returning a stale or empty table.
func TestPlatformTargets_Windows_ExportedWrapperMatchesInternal(t *testing.T) {
	home := t.TempDir()
	got := PlatformTargets(home)
	want := platformTargets(home)

	if len(got) != len(want) {
		t.Fatalf("PlatformTargets() returned %d targets, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("PlatformTargets()[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

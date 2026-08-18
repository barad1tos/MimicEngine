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
	home := t.TempDir()
	targets := platformTargets(home)

	want := map[string]string{
		"chrome":   `Software\Google\Chrome\NativeMessagingHosts\` + HostName,
		"chromium": `Software\Chromium\NativeMessagingHosts\` + HostName,
		"brave":    `Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\` + HostName,
		"edge":     `Software\Microsoft\Edge\NativeMessagingHosts\` + HostName,
		"vivaldi":  `Software\Vivaldi\NativeMessagingHosts\` + HostName,
		"firefox":  `Software\Mozilla\NativeMessagingHosts\` + HostName,
	}

	got := make(map[string]Target, len(targets))
	for _, tg := range targets {
		got[tg.ID] = tg
	}

	for id, wantPath := range want {
		tg, ok := got[id]
		if !ok {
			t.Errorf("platformTargets(home) is missing id %q", id)
			continue
		}
		if tg.RegistryPath != wantPath {
			t.Errorf("%s.RegistryPath = %q, want %q (the exact key Chrome/Firefox read)", id, tg.RegistryPath, wantPath)
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

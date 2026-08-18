//go:build darwin

package setup

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestPlatformTargets_Darwin_KnownIDsAndDia exercises the real macOS
// target table (not a synthetic one): every expected browser id is
// present, every Dir sits under home, and Dia's Dir is its Application
// Support root — not a nested NativeMessagingHosts subdirectory, per the
// empirically verified behavior platformTargets' doc comment describes.
func TestPlatformTargets_Darwin_KnownIDsAndDia(t *testing.T) {
	home := t.TempDir()
	targets := platformTargets(home)

	wantIDs := []string{"chrome", "chromium", "arc", "brave", "edge", "vivaldi", "dia", "firefox"}
	gotIDs := make(map[string]Target, len(targets))
	for _, tg := range targets {
		gotIDs[tg.ID] = tg
	}
	for _, id := range wantIDs {
		tg, ok := gotIDs[id]
		if !ok {
			t.Errorf("platformTargets(home) is missing id %q", id)
			continue
		}
		if !strings.HasPrefix(tg.Dir, home) {
			t.Errorf("%s.Dir = %q, want it anchored under home %q", id, tg.Dir, home)
		}
		if tg.RegistryPath != "" {
			t.Errorf("%s.RegistryPath = %q, want empty on macOS", id, tg.RegistryPath)
		}
	}

	diaWant := filepath.Join(home, "Library", "Application Support", "Dia")
	if gotIDs["dia"].Dir != diaWant {
		t.Errorf("dia.Dir = %q, want the Application Support root %q (no NativeMessagingHosts subdir)", gotIDs["dia"].Dir, diaWant)
	}

	if gotIDs["firefox"].Family != Firefox {
		t.Errorf("firefox.Family = %v, want Firefox", gotIDs["firefox"].Family)
	}
	if gotIDs["chrome"].Family != Chromium {
		t.Errorf("chrome.Family = %v, want Chromium", gotIDs["chrome"].Family)
	}
}

// TestPlatformTargets_ExportedWrapperMatchesInternal proves the exported
// PlatformTargets wrapper actually delegates to platformTargets rather
// than, say, returning a stale or empty table.
func TestPlatformTargets_ExportedWrapperMatchesInternal(t *testing.T) {
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

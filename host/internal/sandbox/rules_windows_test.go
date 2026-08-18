//go:build windows

package sandbox

import (
	"path/filepath"
	"testing"
)

// TestPlatformRules_Windows_FixtureLayout mirrors the darwin fixture test
// for Windows's table (no kitty, Ghostty, or iTerm2 — none ship a native
// Windows build). It exercises both the %APPDATA%-set and fallback paths.
func TestPlatformRules_Windows_FixtureLayout(t *testing.T) {
	home := resolvedTempDir(t) // Path comparisons below need the same symlink resolution Box applies to every root.
	appData := filepath.Join(home, "AppData", "Roaming")
	t.Setenv("APPDATA", appData)

	type planted struct {
		sourceID string
		fullPath string
	}
	fixtures := []planted{
		{"jetbrains", filepath.Join(appData, "JetBrains", "IntelliJIdea2024.1", "colors", "Dark.icls")},
		{"jetbrains", filepath.Join(appData, "JetBrains", "Custom.theme.json")},
		{"vscode", filepath.Join(home, ".vscode", "extensions", "pub.ext-1.0.0", "themes", "dark.json")},
		{"alacritty", filepath.Join(appData, "alacritty", "alacritty.toml")},
	}
	for _, fx := range fixtures {
		mustMkdirAll(t, filepath.Dir(fx.fullPath))
		mustWriteFile(t, fx.fullPath, "fixture")
	}

	box := mustNewBox(t, platformRules(home))

	result, err := box.Enumerate(10000, 500)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	found := make(map[string]string, len(result.Files))
	for _, r := range result.Files {
		found[r.Path] = r.SourceID
	}

	for _, fx := range fixtures {
		gotSourceID, ok := found[fx.fullPath]
		if !ok {
			t.Errorf("fixture %s (source %s) not found in Enumerate results", fx.fullPath, fx.sourceID)
			continue
		}
		if gotSourceID != fx.sourceID {
			t.Errorf("fixture %s: sourceID = %q, want %q", fx.fullPath, gotSourceID, fx.sourceID)
		}
	}
}

func TestPlatformRules_Windows_AppDataFallback(t *testing.T) {
	home := t.TempDir()
	t.Setenv("APPDATA", "")

	rules := platformRules(home)
	want := filepath.Join(home, "AppData", "Roaming", "JetBrains")
	for _, r := range rules {
		if r.SourceID == "jetbrains" && r.Root != want {
			t.Fatalf("jetbrains root = %q, want %q when APPDATA is unset", r.Root, want)
		}
	}
}

func TestPlatformRules_Windows_NoUnsupportedApps(t *testing.T) {
	home := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	box := mustNewBox(t, platformRules(home))

	unsupported := map[string]bool{"kitty": true, "ghostty": true, "iterm": true}
	for _, id := range box.SourceIDs() {
		if unsupported[id] {
			t.Fatalf("SourceIDs() included %q on Windows, want it omitted (no native Windows build)", id)
		}
	}
}

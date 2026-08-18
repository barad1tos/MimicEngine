//go:build linux

package sandbox

import (
	"path/filepath"
	"testing"
)

// TestPlatformRules_Linux_FixtureLayout mirrors the darwin fixture test for
// Linux's smaller table (no iTerm2, which has no Linux build).
func TestPlatformRules_Linux_FixtureLayout(t *testing.T) {
	home := resolvedTempDir(t) // Path comparisons below need the same symlink resolution Box applies to every root.

	type planted struct {
		sourceID string
		relPath  string
	}
	fixtures := []planted{
		{"jetbrains", filepath.Join(".config", "JetBrains", "IntelliJIdea2024.1", "colors", "Dark.icls")},
		{"jetbrains", filepath.Join(".config", "JetBrains", "Custom.theme.json")},
		{"vscode", filepath.Join(".vscode", "extensions", "pub.ext-1.0.0", "themes", "dark.json")},
		{"alacritty", filepath.Join(".config", "alacritty", "alacritty.toml")},
		{"kitty", filepath.Join(".config", "kitty", "kitty.conf")},
		{"ghostty", filepath.Join(".config", "ghostty", "config")},
	}
	for _, fx := range fixtures {
		full := filepath.Join(home, fx.relPath)
		mustMkdirAll(t, filepath.Dir(full))
		mustWriteFile(t, full, "fixture")
	}

	box := mustNewBox(t, platformRules(home))

	results, err := box.Enumerate(10000, 500)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	found := make(map[string]string, len(results))
	for _, r := range results {
		found[r.Path] = r.SourceID
	}

	for _, fx := range fixtures {
		full := filepath.Join(home, fx.relPath)
		gotSourceID, ok := found[full]
		if !ok {
			t.Errorf("fixture %s (source %s) not found in Enumerate results", fx.relPath, fx.sourceID)
			continue
		}
		if gotSourceID != fx.sourceID {
			t.Errorf("fixture %s: sourceID = %q, want %q", fx.relPath, gotSourceID, fx.sourceID)
		}
	}
}

func TestPlatformRules_Linux_NoITerm(t *testing.T) {
	home := t.TempDir()
	box := mustNewBox(t, platformRules(home))

	for _, id := range box.SourceIDs() {
		if id == "iterm" {
			t.Fatal("SourceIDs() included \"iterm\" on Linux, want it omitted (iTerm2 has no Linux build)")
		}
	}
}

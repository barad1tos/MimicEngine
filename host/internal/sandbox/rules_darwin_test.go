//go:build darwin

package sandbox

import (
	"path/filepath"
	"testing"
)

// TestPlatformRules_Darwin_FixtureLayout plants one file per macOS
// allowlist pattern under a temp HOME, plus a decoy per source that must
// NOT match, and asserts platformRules' real table (not a synthetic one)
// finds exactly the allowed files via both Enumerate and Open.
func TestPlatformRules_Darwin_FixtureLayout(t *testing.T) {
	home := resolvedTempDir(t) // Path comparisons below need the same symlink resolution Box applies to every root.

	type planted struct {
		sourceID string
		relPath  string
	}
	fixtures := []planted{
		{"jetbrains", filepath.Join("Library", "Application Support", "JetBrains", "IntelliJIdea2024.1", "colors", "Dark.icls")},
		{"jetbrains", filepath.Join("Library", "Application Support", "JetBrains", "Custom.theme.json")},
		{"vscode", filepath.Join(".vscode", "extensions", "pub.ext-1.0.0", "themes", "dark.json")},
		{"alacritty", filepath.Join(".config", "alacritty", "alacritty.toml")},
		{"kitty", filepath.Join(".config", "kitty", "kitty.conf")},
		{"kitty", filepath.Join(".config", "kitty", "current-theme.conf")},
		{"kitty", filepath.Join(".config", "kitty", "themes", "dark.conf")},
		{"ghostty", filepath.Join(".config", "ghostty", "config")},
		{"ghostty", filepath.Join(".config", "ghostty", "themes", "dark")},
		{"ghostty", filepath.Join("Library", "Application Support", "com.mitchellh.ghostty", "config")},
		{"iterm", filepath.Join("Downloads", "Solarized.itermcolors")},
	}
	for _, fx := range fixtures {
		full := filepath.Join(home, fx.relPath)
		mustMkdirAll(t, filepath.Dir(full))
		mustWriteFile(t, full, "fixture")
	}

	decoys := []string{
		filepath.Join(home, "Library", "Application Support", "JetBrains", "options.xml"),
		filepath.Join(home, ".vscode", "extensions", "pub.ext-1.0.0", "package.json"),
		filepath.Join(home, ".config", "alacritty", "README.md"),
		filepath.Join(home, "Downloads", "not-a-theme.txt"),
	}
	for _, d := range decoys {
		mustMkdirAll(t, filepath.Dir(d))
		mustWriteFile(t, d, "decoy")
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
		full := filepath.Join(home, fx.relPath)
		gotSourceID, ok := found[full]
		if !ok {
			t.Errorf("fixture %s (source %s) not found in Enumerate results", fx.relPath, fx.sourceID)
			continue
		}
		if gotSourceID != fx.sourceID {
			t.Errorf("fixture %s: sourceID = %q, want %q", fx.relPath, gotSourceID, fx.sourceID)
		}
		if f, err := box.Open(full); err != nil {
			t.Errorf("Open(%s) = %v, want success for an allow-listed fixture", fx.relPath, err)
		} else {
			_ = f.Close()
		}
	}

	for _, d := range decoys {
		if sourceID, ok := found[d]; ok {
			t.Errorf("decoy %s unexpectedly matched rule %q", d, sourceID)
		}
		if _, err := box.Open(d); err == nil {
			t.Errorf("Open(%s) succeeded, want denial for a non-matching decoy", d)
		}
	}
}

func TestPlatformRules_Darwin_SourceIDs(t *testing.T) {
	home := t.TempDir()
	box := mustNewBox(t, platformRules(home))

	want := map[string]bool{"jetbrains": true, "vscode": true, "alacritty": true, "kitty": true, "ghostty": true, "iterm": true}
	got := box.SourceIDs()
	if len(got) != len(want) {
		t.Fatalf("SourceIDs() = %v, want exactly %v", got, want)
	}
	for _, id := range got {
		if !want[id] {
			t.Errorf("SourceIDs() included unexpected id %q", id)
		}
	}
}

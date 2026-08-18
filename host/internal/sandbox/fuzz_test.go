package sandbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// FuzzOpenPath asserts the sandbox's core safety property under arbitrary
// input: Open must never return a file outside every allow-listed root, and
// must never panic. Most fuzz inputs will simply fail to resolve (there is
// no file there) — the interesting cases are traversal and symlink-like
// strings that happen to resolve to something on disk.
func FuzzOpenPath(f *testing.F) {
	home := f.TempDir()
	root := filepath.Join(home, ".config", "alacritty")
	if err := os.MkdirAll(root, 0o755); err != nil {
		f.Fatalf("MkdirAll: %v", err)
	}
	allowed := filepath.Join(root, "alacritty.toml")
	if err := os.WriteFile(allowed, []byte("theme = 1"), 0o644); err != nil {
		f.Fatalf("WriteFile: %v", err)
	}

	outsideDir := f.TempDir()
	secret := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(secret, []byte("nope"), 0o644); err != nil {
		f.Fatalf("WriteFile: %v", err)
	}
	escapeLink := filepath.Join(root, "escape.toml")
	if err := os.Symlink(secret, escapeLink); err != nil {
		f.Fatalf("Symlink: %v", err)
	}

	box, err := newBox([]Rule{
		{SourceID: "alacritty", Root: root, Patterns: []string{"alacritty.toml", "*.toml"}},
	})
	if err != nil {
		f.Fatalf("newBox: %v", err)
	}

	seeds := []string{
		allowed,
		escapeLink,
		secret,
		root,
		home,
		"",
		"/etc/passwd",
		"../../../../../../etc/passwd",
		filepath.Join(root, "..", "..", "..", "etc", "passwd"),
		filepath.Join(root, "does-not-exist.toml"),
		"\x00",
		strings.Repeat("../", 64) + "etc/passwd",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	resolvedRoots := make([]string, len(box.rules))
	for i, r := range box.rules {
		resolvedRoots[i] = r.root
	}

	f.Fuzz(func(t *testing.T, candidate string) {
		file, err := box.Open(candidate)
		if err != nil {
			return
		}
		defer func() { _ = file.Close() }()

		name := file.Name()
		for _, r := range resolvedRoots {
			if name == r || strings.HasPrefix(name, r+string(filepath.Separator)) {
				return
			}
		}
		t.Fatalf("Open(%q) returned a file outside every allow-listed root: %s", candidate, name)
	})
}

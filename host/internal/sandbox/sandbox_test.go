package sandbox

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// *Box must satisfy ops.sourceLister (SourceIDs() []string) so main can
// hand a real Box to ops.Serve in place of Task 1's noSources stand-in.
// sandbox cannot import ops (that would invert the module's dependency
// direction — internal/ops depends on internal/sandbox, never the other
// way), so this pins the method set locally instead.
var _ interface{ SourceIDs() []string } = (*Box)(nil)

func TestNew_EmptyHome(t *testing.T) {
	if _, err := New(""); err == nil {
		t.Fatal("New(\"\") = nil error, want an error")
	}
}

func TestNewBox_RejectsRelativeRoot(t *testing.T) {
	_, err := newBox([]Rule{{SourceID: "test", Root: "relative/path", Patterns: []string{"*.toml"}}})
	if err == nil {
		t.Fatal("newBox() = nil error, want an error for a non-absolute root")
	}
}

func TestNewBox_RejectsDoubleStarPattern(t *testing.T) {
	home := t.TempDir()
	_, err := newBox([]Rule{{SourceID: "test", Root: home, Patterns: []string{"**/x.toml"}}})
	if err == nil {
		t.Fatal("newBox() = nil error, want an error for a \"**\" pattern")
	}
}

func TestSourceIDs_DedupesInTableOrder(t *testing.T) {
	home := t.TempDir()
	box, err := newBox([]Rule{
		{SourceID: "ghostty", Root: filepath.Join(home, "a"), Patterns: []string{"config"}},
		{SourceID: "iterm", Root: filepath.Join(home, "b"), Patterns: []string{"*.itermcolors"}},
		{SourceID: "ghostty", Root: filepath.Join(home, "c"), Patterns: []string{"config"}},
	})
	if err != nil {
		t.Fatalf("newBox: %v", err)
	}

	got := box.SourceIDs()
	want := []string{"ghostty", "iterm"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("SourceIDs() = %v, want %v", got, want)
	}
}

func TestOpen_AllowedFile(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "root")
	mustMkdirAll(t, root)
	target := filepath.Join(root, "theme.toml")
	mustWriteFile(t, target, "ok")

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	f, err := box.Open(target)
	if err != nil {
		t.Fatalf("Open() = %v, want success", err)
	}
	defer func() { _ = f.Close() }()
}

func TestOpen_TraversalDenied(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "root")
	outside := filepath.Join(home, "outside")
	mustMkdirAll(t, root)
	mustMkdirAll(t, outside)
	secret := filepath.Join(outside, "secret.toml")
	mustWriteFile(t, secret, "secret")

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	traversal := filepath.Join(root, "..", "outside", "secret.toml")
	_, err := box.Open(traversal)
	if err == nil {
		t.Fatal("Open() = nil error, want denial for a \"..\" traversal")
	}
	if !errors.Is(err, ErrDenied) {
		t.Fatalf("Open() error = %v, want errors.Is(err, ErrDenied)", err)
	}
}

func TestOpen_PatternMissDenied(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "root")
	mustMkdirAll(t, root)
	nonMatching := filepath.Join(root, "readme.md")
	mustWriteFile(t, nonMatching, "nope")

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	_, err := box.Open(nonMatching)
	if err == nil {
		t.Fatal("Open() = nil error, want denial for a non-matching pattern")
	}
	if !errors.Is(err, ErrDenied) {
		t.Fatalf("Open() error = %v, want errors.Is(err, ErrDenied)", err)
	}
}

func TestOpen_SymlinkEscapesRootDenied(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "root")
	outside := filepath.Join(home, "outside")
	mustMkdirAll(t, root)
	mustMkdirAll(t, outside)
	secret := filepath.Join(outside, "secret.toml")
	mustWriteFile(t, secret, "secret")

	link := filepath.Join(root, "escape.toml")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	_, err := box.Open(link)
	if err == nil {
		t.Fatal("Open() = nil error, want denial for a symlink escaping its root")
	}
	if !errors.Is(err, ErrDenied) {
		t.Fatalf("Open() error = %v, want errors.Is(err, ErrDenied)", err)
	}
}

// TestOpen_TOCTOUSwapDenied simulates a file getting swapped for a
// different one at the same path in the exact window Open's post-open
// verification is designed to guard: after the descriptor has been opened
// and fstat'd, before the resolved path is stat'd again. The swap is
// unlink-then-recreate, which relies on POSIX letting an already-open
// descriptor keep referencing the unlinked inode — Windows delete
// semantics differ, so this test is Unix-only.
func TestOpen_TOCTOUSwapDenied(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("relies on POSIX unlink-while-open semantics")
	}

	home := t.TempDir()
	root := filepath.Join(home, "root")
	mustMkdirAll(t, root)
	original := filepath.Join(root, "theme.toml")
	mustWriteFile(t, original, "original")

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	t.Cleanup(func() { toctouHook = nil })
	toctouHook = func(resolvedPath string) {
		if err := os.Remove(resolvedPath); err != nil {
			t.Fatalf("simulated swap: Remove: %v", err)
		}
		if err := os.WriteFile(resolvedPath, []byte("swapped"), 0o644); err != nil {
			t.Fatalf("simulated swap: WriteFile: %v", err)
		}
	}

	_, err := box.Open(original)
	if err == nil {
		t.Fatal("Open() = nil error, want denial after a TOCTOU swap")
	}
	if !errors.Is(err, ErrDenied) {
		t.Fatalf("Open() error = %v, want errors.Is(err, ErrDenied)", err)
	}
}

func TestOpen_NonexistentRootMeansNothingMatches(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "never-created")
	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	if _, err := box.Open(filepath.Join(root, "x.toml")); err == nil {
		t.Fatal("Open() = nil error, want denial when the root does not exist")
	}
}

func TestCaseFold_IdentityOffWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("this pins the identity branch exercised on non-Windows CI runners")
	}
	if got := caseFold("MixedCase"); got != "MixedCase" {
		t.Fatalf("caseFold(%q) = %q, want unchanged on %s", "MixedCase", got, runtime.GOOS)
	}
}

// --- shared test helpers (used by every _test.go file in this package) ---

func mustNewBox(t *testing.T, rules []Rule) *Box {
	t.Helper()
	box, err := newBox(rules)
	if err != nil {
		t.Fatalf("newBox: %v", err)
	}
	return box
}

func mustMkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", dir, err)
	}
}

func mustWriteFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

// resolvedTempDir returns a fresh t.TempDir(), symlink-resolved. On macOS
// t.TempDir() lives under /var, which is itself a symlink to /private/var;
// Box resolves every root the same way (resolveRootBestEffort), so tests
// that compare a FileInfo.Path or an Open target against a path built from
// the raw home string need the same resolution applied first, or the
// comparison spuriously fails on the symlink alone.
func resolvedTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", dir, err)
	}
	return resolved
}

package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestEnumerate_WalkBudgetStops(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "root")
	mustMkdirAll(t, root)
	const planted = 20
	for i := range planted {
		mustWriteFile(t, filepath.Join(root, fmt.Sprintf("file-%02d.toml", i)), "x")
	}

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	const budget = 5
	result, err := box.Enumerate(budget, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}

	if len(result.Files) >= planted {
		t.Fatalf("Enumerate did not stop at the walk budget: got %d results from %d planted files (budget=%d)",
			len(result.Files), planted, budget)
	}
	if len(result.Files) > budget {
		t.Fatalf("Enumerate returned %d results, more than the budget (%d) allows", len(result.Files), budget)
	}
	if !result.Truncated {
		t.Fatal("Enumerate() Truncated = false, want true when the walk budget is exhausted")
	}
}

func TestEnumerate_WalkBudgetSharedAcrossRoots(t *testing.T) {
	home := t.TempDir()
	rootA := filepath.Join(home, "a")
	rootB := filepath.Join(home, "b")
	mustMkdirAll(t, rootA)
	mustMkdirAll(t, rootB)
	for i := range 10 {
		mustWriteFile(t, filepath.Join(rootA, fmt.Sprintf("a-%02d.toml", i)), "x")
		mustWriteFile(t, filepath.Join(rootB, fmt.Sprintf("b-%02d.toml", i)), "x")
	}

	box := mustNewBox(t, []Rule{
		{SourceID: "a", Root: rootA, Patterns: []string{"*.toml"}},
		{SourceID: "b", Root: rootB, Patterns: []string{"*.toml"}},
	})

	// A budget that only covers rootA's own entries (root dir + 10 files =
	// 11) must not let rootB contribute any results — the budget is shared
	// across the whole Enumerate call, not reset per root.
	const budget = 11
	result, err := box.Enumerate(budget, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	for _, r := range result.Files {
		if r.SourceID == "b" {
			t.Fatalf("Enumerate() included a rootB result (%s) after the shared budget was exhausted by rootA", r.Path)
		}
	}
	if !result.Truncated {
		t.Fatal("Enumerate() Truncated = false, want true when the shared walk budget is exhausted")
	}
}

func TestEnumerate_ResultCap(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "root")
	mustMkdirAll(t, root)
	for i := range 10 {
		mustWriteFile(t, filepath.Join(root, fmt.Sprintf("file-%02d.toml", i)), "x")
	}

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	const maxResults = 3
	result, err := box.Enumerate(10000, maxResults)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(result.Files) != maxResults {
		t.Fatalf("Enumerate() returned %d results, want exactly %d (the cap)", len(result.Files), maxResults)
	}
	if !result.Truncated {
		t.Fatal("Enumerate() Truncated = false, want true when the result cap is hit with more matches left unwalked")
	}
}

func TestEnumerate_SortedByPath(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "root")
	mustMkdirAll(t, root)
	for _, name := range []string{"zebra.toml", "alpha.toml", "mid.toml"} {
		mustWriteFile(t, filepath.Join(root, name), "x")
	}

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	result, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(result.Files) != 3 {
		t.Fatalf("len(result.Files) = %d, want 3", len(result.Files))
	}
	if !sort.SliceIsSorted(result.Files, func(i, j int) bool { return result.Files[i].Path < result.Files[j].Path }) {
		t.Fatalf("Enumerate() results not sorted by path: %+v", result.Files)
	}
	if result.Truncated {
		t.Fatal("Enumerate() Truncated = true, want false when neither the walk budget nor the result cap was hit")
	}
}

func TestEnumerate_PatternMissNotEnumerated(t *testing.T) {
	home := resolvedTempDir(t) // Path comparisons below need the same symlink resolution Box applies to every root.
	root := filepath.Join(home, "root")
	mustMkdirAll(t, root)
	matching := filepath.Join(root, "theme.toml")
	nonMatching := filepath.Join(root, "readme.md")
	mustWriteFile(t, matching, "x")
	mustWriteFile(t, nonMatching, "x")

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	result, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(result.Files) != 1 || result.Files[0].Path != matching {
		t.Fatalf("Enumerate() = %+v, want exactly one result for %s", result.Files, matching)
	}
}

func TestEnumerate_SymlinkedFileEscapesDenied(t *testing.T) {
	home := resolvedTempDir(t) // Path comparisons below need the same symlink resolution Box applies to every root.
	root, _, secret := mustPlantOutside(t, home, "outside", "secret.toml", "secret")
	link := filepath.Join(root, "escape.toml")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	result, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	for _, r := range result.Files {
		if r.Path == secret {
			t.Fatalf("Enumerate() included %s via an escaping symlink, want it denied", secret)
		}
	}
}

func TestEnumerate_SymlinkedFileWithinAllowlistResolves(t *testing.T) {
	home := resolvedTempDir(t) // Path comparisons below need the same symlink resolution Box applies to every root.
	root := filepath.Join(home, "root")
	mustMkdirAll(t, root)
	realFile := filepath.Join(root, "real.toml")
	mustWriteFile(t, realFile, "x")
	link := filepath.Join(root, "alias.toml")
	if err := os.Symlink(realFile, link); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	result, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	// Both the symlink and its target resolve to the same allow-listed
	// file, so exactly one entry — the resolved real path — is expected.
	if len(result.Files) != 1 || result.Files[0].Path != realFile {
		t.Fatalf("Enumerate() = %+v, want exactly one result for %s", result.Files, realFile)
	}
}

func TestEnumerate_SymlinkedDirNotFollowed(t *testing.T) {
	home := resolvedTempDir(t) // Path comparisons below need the same symlink resolution Box applies to every root.
	root, outsideDir, _ := mustPlantOutside(t, home, "outside-dir", "hidden.toml", "x")

	linkDir := filepath.Join(root, "linked")
	if err := os.Symlink(outsideDir, linkDir); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	result, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(result.Files) != 0 {
		t.Fatalf("Enumerate() = %+v, want 0 (WalkDir must not descend into a symlinked directory)", result.Files)
	}
}

func TestEnumerate_MissingRootReturnsEmpty(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "never-created")
	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	result, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(result.Files) != 0 {
		t.Fatalf("Enumerate() = %d results, want 0 for a missing root", len(result.Files))
	}
}

// mustPlantOutside creates an allow-listed root and an "outside" sibling
// directory under home, writes fileName inside outside with content, and
// returns (root, outside dir, planted file path) — the setup every
// escaping-symlink test in this file shares before it links from root back
// into outside, whether the link target ends up being the file itself or
// its containing directory.
func mustPlantOutside(t *testing.T, home, outsideDirName, fileName, content string) (root, outsideDir, plantedPath string) {
	t.Helper()
	root = filepath.Join(home, "root")
	outsideDir = filepath.Join(home, outsideDirName)
	mustMkdirAll(t, root)
	mustMkdirAll(t, outsideDir)
	plantedPath = filepath.Join(outsideDir, fileName)
	mustWriteFile(t, plantedPath, content)
	return root, outsideDir, plantedPath
}

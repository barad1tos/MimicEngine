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
	results, err := box.Enumerate(budget, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}

	if len(results) >= planted {
		t.Fatalf("Enumerate did not stop at the walk budget: got %d results from %d planted files (budget=%d)",
			len(results), planted, budget)
	}
	if len(results) > budget {
		t.Fatalf("Enumerate returned %d results, more than the budget (%d) allows", len(results), budget)
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
	results, err := box.Enumerate(budget, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	for _, r := range results {
		if r.SourceID == "b" {
			t.Fatalf("Enumerate() included a rootB result (%s) after the shared budget was exhausted by rootA", r.Path)
		}
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
	results, err := box.Enumerate(10000, maxResults)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(results) != maxResults {
		t.Fatalf("Enumerate() returned %d results, want exactly %d (the cap)", len(results), maxResults)
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

	results, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("len(results) = %d, want 3", len(results))
	}
	if !sort.SliceIsSorted(results, func(i, j int) bool { return results[i].Path < results[j].Path }) {
		t.Fatalf("Enumerate() results not sorted by path: %+v", results)
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

	results, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(results) != 1 || results[0].Path != matching {
		t.Fatalf("Enumerate() = %+v, want exactly one result for %s", results, matching)
	}
}

func TestEnumerate_SymlinkedFileEscapesDenied(t *testing.T) {
	home := resolvedTempDir(t) // Path comparisons below need the same symlink resolution Box applies to every root.
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

	results, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	for _, r := range results {
		if r.Path == secret {
			t.Fatalf("Enumerate() included %s via an escaping symlink, want it denied", secret)
		}
	}
}

func TestEnumerate_SymlinkedFileWithinAllowlistResolves(t *testing.T) {
	home := resolvedTempDir(t) // Path comparisons below need the same symlink resolution Box applies to every root.
	root := filepath.Join(home, "root")
	mustMkdirAll(t, root)
	real := filepath.Join(root, "real.toml")
	mustWriteFile(t, real, "x")
	link := filepath.Join(root, "alias.toml")
	if err := os.Symlink(real, link); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	results, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	// Both the symlink and its target resolve to the same allow-listed
	// file, so exactly one entry — the resolved real path — is expected.
	if len(results) != 1 || results[0].Path != real {
		t.Fatalf("Enumerate() = %+v, want exactly one result for %s", results, real)
	}
}

func TestEnumerate_SymlinkedDirNotFollowed(t *testing.T) {
	home := resolvedTempDir(t) // Path comparisons below need the same symlink resolution Box applies to every root.
	root := filepath.Join(home, "root")
	outsideDir := filepath.Join(home, "outside-dir")
	mustMkdirAll(t, root)
	mustMkdirAll(t, outsideDir)
	hidden := filepath.Join(outsideDir, "hidden.toml")
	mustWriteFile(t, hidden, "x")

	linkDir := filepath.Join(root, "linked")
	if err := os.Symlink(outsideDir, linkDir); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	results, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("Enumerate() = %+v, want 0 (WalkDir must not descend into a symlinked directory)", results)
	}
}

func TestEnumerate_MissingRootReturnsEmpty(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "never-created")
	box := mustNewBox(t, []Rule{{SourceID: "test", Root: root, Patterns: []string{"*.toml"}}})

	results, err := box.Enumerate(1000, 1000)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("Enumerate() = %d results, want 0 for a missing root", len(results))
	}
}

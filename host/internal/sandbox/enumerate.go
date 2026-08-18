package sandbox

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// FileInfo describes one allow-listed file discovered by Enumerate.
type FileInfo struct {
	Path       string // absolute, symlink-resolved
	Size       int64
	ModifiedAt string // RFC3339, UTC
	SourceID   string
}

// Enumerate walks every rule's root, in table order, collecting files that
// match their rule's patterns. visited entries — directories and files
// alike, across every root — are counted against a single shared budget;
// once budget is exceeded the current root's walk stops immediately (via
// fs.SkipAll) and every subsequent root's walk stops on its first entry, so
// the cap holds regardless of how many roots exist or in what order they
// are walked. Collection separately stops once maxResults matches have been
// found. Results are sorted by path before returning, independent of walk
// or table order, so the response is deterministic.
//
// A symlinked file that matches its containing rule's pattern is resolved
// and re-verified against the FULL allowlist (as Open would) before being
// included; a symlink that resolves outside every rule is denied, not
// enumerated. filepath.WalkDir does not descend into symlinked directories,
// so nothing beneath one is ever visited or leaked this way. Results are
// deduplicated by resolved path, since a symlink can resolve to a file
// WalkDir also visits directly (or that a different symlink already
// resolved to) — each real file is reported at most once.
func (b *Box) Enumerate(budget, maxResults int) ([]FileInfo, error) {
	var results []FileInfo
	visited := 0
	seen := make(map[string]bool) // resolved path -> already collected; a symlink can resolve to a file WalkDir also visits directly, or that another symlink already resolved to

	for _, rule := range b.rules {
		if len(results) >= maxResults {
			break
		}

		walkErr := filepath.WalkDir(rule.root, func(walkPath string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // missing root or unreadable entry: best-effort skip
			}

			visited++
			if visited > budget {
				return fs.SkipAll
			}
			if d.IsDir() {
				return nil
			}

			entryPath := walkPath
			sourceID := rule.sourceID
			var info fs.FileInfo

			if d.Type()&fs.ModeSymlink != 0 {
				target, evalErr := filepath.EvalSymlinks(walkPath)
				if evalErr != nil {
					return nil // dangling symlink
				}
				matchedRule, ok := b.match(target)
				if !ok {
					return nil // escapes the allowlist: deny, don't enumerate
				}
				targetInfo, statErr := os.Stat(target)
				if statErr != nil || !targetInfo.Mode().IsRegular() {
					return nil
				}
				entryPath = target
				sourceID = matchedRule.sourceID
				info = targetInfo
			} else {
				fi, infoErr := d.Info()
				if infoErr != nil || !fi.Mode().IsRegular() {
					return nil
				}
				rel, relErr := filepath.Rel(rule.root, walkPath)
				if relErr != nil || !matchesAnyPattern(rule.patterns, filepath.ToSlash(rel)) {
					return nil
				}
				info = fi
			}

			if seen[entryPath] {
				return nil
			}
			if len(results) >= maxResults {
				return fs.SkipAll
			}
			seen[entryPath] = true
			results = append(results, FileInfo{
				Path:       entryPath,
				Size:       info.Size(),
				ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
				SourceID:   sourceID,
			})
			return nil
		})
		if walkErr != nil {
			return nil, fmt.Errorf("enumerating %s: %w", rule.sourceID, walkErr)
		}
	}

	sort.Slice(results, func(i, j int) bool { return results[i].Path < results[j].Path })
	return results, nil
}

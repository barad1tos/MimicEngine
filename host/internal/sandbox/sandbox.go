// Package sandbox is the native-messaging host's security core. It holds
// the allowlist of (root, pattern) rules the host will ever read from, and
// verifies every path against it in two passes: once before opening
// (resolve, then prefix- and pattern-check against the resolved root) and
// once after (fstat the descriptor and compare it, via os.SameFile, against
// a fresh stat of the resolved path).
//
// PRECISION on what that second pass actually buys: it closes the
// open↔verify window — a swap landing there is caught rather than trusted.
// A swap landing in the earlier resolve↔open window is NOT caught by this
// package. Winning that earlier race requires write access to an
// allow-listed directory, which already sits inside the accepted
// local-attacker boundary — this is a known, stated limitation, not a
// defended one.
//
// Bare directory roots are deliberately never enough on their own — a rule
// always pairs a root with the file patterns permitted under it, so e.g. a
// JetBrains config root grants access to color scheme files, never to
// options.xml alongside them.
package sandbox

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ErrDenied wraps every rejection Open and Enumerate's symlink checks
// produce: a path outside every allow-listed root, a pattern mismatch, or a
// TOCTOU swap caught at verification time. Callers use
// errors.Is(err, sandbox.ErrDenied) to map any of these to the protocol's
// path-denied error code.
var ErrDenied = errors.New("sandbox: path denied")

// Rule pairs one allow-listed source with the directory it may be read
// from and the file patterns permitted under that directory. Root must be
// an absolute path by the time it reaches newBox: platformRules anchors
// every rule's root to home (or, on Windows, to %APPDATA%) before
// returning, and New performs the symlink resolution described in the
// package doc over the result.
type Rule struct {
	SourceID string
	Root     string
	Patterns []string
}

// resolvedRule is a Rule after New has symlink-resolved its root.
type resolvedRule struct {
	sourceID string
	root     string
	patterns []string
}

// Box is a resolved, read-only view over the current platform's allowlist.
// It is safe for concurrent use: construction fully populates it and
// nothing about a Box is ever mutated afterward.
type Box struct {
	rules []resolvedRule
}

// New builds the sandbox for the current OS, anchoring every rule at home.
// home is normally the result of os.UserHomeDir(); tests pass a temporary
// directory to exercise the allowlist against a planted fixture layout
// instead of the caller's real home directory.
func New(home string) (*Box, error) {
	if home == "" {
		return nil, errors.New("sandbox: home must not be empty")
	}
	absHome, err := filepath.Abs(home)
	if err != nil {
		return nil, fmt.Errorf("resolving home %q: %w", home, err)
	}
	return newBox(platformRules(absHome))
}

// newBox resolves and validates a rule table into a Box. It is the shared
// construction path behind New; tests call it directly with synthetic rule
// tables (rooted under t.TempDir()) to exercise matching, traversal, and
// verification without depending on the real per-OS layout or a real home
// directory.
func newBox(rules []Rule) (*Box, error) {
	resolved := make([]resolvedRule, 0, len(rules))
	for _, r := range rules {
		if !filepath.IsAbs(r.Root) {
			return nil, fmt.Errorf("rule %q: root %q must be an absolute path", r.SourceID, r.Root)
		}
		for _, p := range r.Patterns {
			if err := validatePattern(p); err != nil {
				return nil, fmt.Errorf("rule %q: %w", r.SourceID, err)
			}
		}
		resolved = append(resolved, resolvedRule{
			sourceID: r.SourceID,
			root:     resolveRootBestEffort(r.Root),
			patterns: r.Patterns,
		})
	}
	return &Box{rules: resolved}, nil
}

// resolveRootBestEffort symlink-resolves root. A root that does not exist
// on this machine — an app the user has not installed is the common case,
// not an error — is kept in its clean absolute form, under which nothing
// will ever match.
func resolveRootBestEffort(root string) string {
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return filepath.Clean(root)
	}
	return resolved
}

// SourceIDs returns the distinct source identifiers covered by this Box's
// rules, in rule-table order with duplicates removed (a source can own more
// than one rule — Ghostty has two config roots on macOS).
func (b *Box) SourceIDs() []string {
	seen := make(map[string]bool, len(b.rules))
	ids := make([]string, 0, len(b.rules))
	for _, r := range b.rules {
		if seen[r.sourceID] {
			continue
		}
		seen[r.sourceID] = true
		ids = append(ids, r.sourceID)
	}
	return ids
}

// match reports the rule that covers resolved — resolved lies under the
// rule's root and matches one of its patterns — if any does. resolved must
// already be symlink-resolved; match performs no I/O itself.
func (b *Box) match(resolved string) (resolvedRule, bool) {
	for _, r := range b.rules {
		rel, err := filepath.Rel(caseFold(r.root), caseFold(resolved))
		if err != nil {
			continue
		}
		if rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue // outside this rule's root
		}
		if matchesAnyPattern(r.patterns, filepath.ToSlash(rel)) {
			return r, true
		}
	}
	return resolvedRule{}, false
}

// caseFold lowercases s on Windows, whose filesystems are case-insensitive
// (and whose %APPDATA%-derived roots can carry different casing than a
// literal pattern string); it is the identity function elsewhere, so this
// never changes behavior on the platforms this package's tests actually run
// on.
func caseFold(s string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(s)
	}
	return s
}

// toctouHook, when non-nil, runs after the opened descriptor has been
// fstat'd but before the resolved path is stat'd again. Tests use it to
// simulate a filesystem swap landing inside that verification window;
// production code leaves it nil.
var toctouHook func(resolvedPath string)

// Open verifies requestedPath against the allowlist and returns an opened,
// verified *os.File. The caller owns the returned file and must Close it.
//
// Verification happens in two passes. First, requestedPath is
// symlink-resolved and checked against every rule's root and patterns
// before anything is opened — a symlink planted inside an allowed root that
// points outside it is rejected here, never opened. Second, once the
// resolved path is open, the descriptor is fstat'd and the resolved path is
// stat'd again; the two are compared with os.SameFile (portable identity
// comparison — device+inode on Unix, file index on Windows), and a
// mismatch means the filesystem entry changed between open and
// verification, so the file is closed and denied rather than trusted.
//
// Scope, precisely: that second pass closes the open↔verify window only. A
// swap landing in the earlier resolve↔open window is NOT caught — winning
// that race requires write access to an allow-listed directory, already
// inside the accepted local-attacker boundary. See the package doc.
func (b *Box) Open(requestedPath string) (*os.File, error) {
	resolved, err := filepath.EvalSymlinks(requestedPath)
	if err != nil {
		return nil, fmt.Errorf("resolving %q: %w", requestedPath, err)
	}
	if _, ok := b.match(resolved); !ok {
		return nil, fmt.Errorf("%q is not allow-listed: %w", requestedPath, ErrDenied)
	}

	f, err := os.Open(resolved)
	if err != nil {
		return nil, fmt.Errorf("opening %q: %w", resolved, err)
	}
	if err := verifyOpenedFile(f, resolved); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

// verifyOpenedFile is Open's post-open half of the TOCTOU defense described
// on Open: it confirms f is a regular file and that the descriptor still
// identifies the same file currently sitting at resolvedPath.
func verifyOpenedFile(f *os.File, resolvedPath string) error {
	fdInfo, err := f.Stat()
	if err != nil {
		return fmt.Errorf("fstat %q: %w", resolvedPath, err)
	}
	if !fdInfo.Mode().IsRegular() {
		return fmt.Errorf("%q is not a regular file: %w", resolvedPath, ErrDenied)
	}

	if toctouHook != nil {
		toctouHook(resolvedPath)
	}

	pathInfo, err := os.Stat(resolvedPath)
	if err != nil {
		return fmt.Errorf("re-stat %q: %w", resolvedPath, err)
	}
	if !os.SameFile(fdInfo, pathInfo) {
		return fmt.Errorf("%q changed between open and verification: %w", resolvedPath, ErrDenied)
	}
	return nil
}

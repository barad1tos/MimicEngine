package sandbox

import (
	"fmt"
	"path"
	"strings"
)

// validatePattern rejects patterns this package cannot express. "**" is not
// supported anywhere in the allowlist — no spec pattern needs it, since
// every rule matches a fixed number of path segments (e.g. the JetBrains
// color-scheme pattern is exactly two segments: "*/colors/*.icls") — and
// each segment must be a syntactically valid path.Match pattern.
func validatePattern(pattern string) error {
	if strings.Contains(pattern, "**") {
		return fmt.Errorf("pattern %q: \"**\" is not supported, use a fixed-depth segment-wise glob", pattern)
	}
	for _, segment := range strings.Split(pattern, "/") {
		if _, err := path.Match(segment, ""); err != nil {
			return fmt.Errorf("pattern %q: invalid segment %q: %w", pattern, segment, err)
		}
	}
	return nil
}

// matchesAnyPattern reports whether rel — slash-separated, relative to a
// rule's root — matches at least one of patterns.
func matchesAnyPattern(patterns []string, rel string) bool {
	for _, p := range patterns {
		if matchSegments(p, rel) {
			return true
		}
	}
	return false
}

// matchSegments reports whether rel matches pattern segment-by-segment:
// both are split on "/", the segment counts must be equal, and each pair of
// segments is compared with path.Match. This deliberately does not support
// "**" — validatePattern rejects it at construction time — so a pattern
// only ever matches paths at exactly its own depth.
func matchSegments(pattern, rel string) bool {
	pattern = caseFold(pattern)
	rel = caseFold(rel)

	patternSegments := strings.Split(pattern, "/")
	relSegments := strings.Split(rel, "/")
	if len(patternSegments) != len(relSegments) {
		return false
	}
	for i, segment := range patternSegments {
		ok, err := path.Match(segment, relSegments[i])
		if err != nil || !ok {
			return false
		}
	}
	return true
}

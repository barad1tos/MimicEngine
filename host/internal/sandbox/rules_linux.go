//go:build linux

package sandbox

import "path/filepath"

// platformRules returns Linux's allowlist, every root anchored under home
// following each app's standard XDG config location. iTerm2 has no Linux
// build, so no rule exists for it here — SourceIDs simply omits "iterm" on
// this OS, and the extension degrades to fewer scannable cards, per the
// design spec.
func platformRules(home string) []Rule {
	return []Rule{
		{
			SourceID: "jetbrains",
			Root:     filepath.Join(home, ".config", "JetBrains"),
			Patterns: []string{"*/colors/*.icls", "*.theme.json"},
		},
		{
			SourceID: "vscode",
			Root:     filepath.Join(home, ".vscode", "extensions"),
			Patterns: []string{"*/themes/*.json"},
		},
		{
			SourceID: "alacritty",
			Root:     filepath.Join(home, ".config", "alacritty"),
			Patterns: []string{"alacritty.toml", "*.toml"},
		},
		{
			SourceID: "kitty",
			Root:     filepath.Join(home, ".config", "kitty"),
			Patterns: []string{"kitty.conf", "current-theme.conf", "themes/*.conf"},
		},
		{
			SourceID: "ghostty",
			Root:     filepath.Join(home, ".config", "ghostty"),
			Patterns: []string{"config", "themes/*"},
		},
	}
}

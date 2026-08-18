//go:build darwin

package sandbox

import "path/filepath"

// platformRules returns macOS's allowlist, every root anchored under home.
// Ghostty owns two roots (its XDG-style config dir and its macOS
// Application Support dir); every other source owns exactly one.
func platformRules(home string) []Rule {
	return []Rule{
		{
			SourceID: "jetbrains",
			Root:     filepath.Join(home, "Library", "Application Support", "JetBrains"),
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
		{
			SourceID: "ghostty",
			Root:     filepath.Join(home, "Library", "Application Support", "com.mitchellh.ghostty"),
			Patterns: []string{"config", "themes/*"},
		},
		{
			SourceID: "iterm",
			Root:     filepath.Join(home, "Downloads"),
			Patterns: []string{"*.itermcolors"},
		},
	}
}

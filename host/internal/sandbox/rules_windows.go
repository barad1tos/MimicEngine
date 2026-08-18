//go:build windows

package sandbox

import (
	"os"
	"path/filepath"
)

// platformRules returns Windows's allowlist. kitty, Ghostty, and iTerm2
// have no native Windows build, so no rules exist for them here — SourceIDs
// omits those ids on this OS. JetBrains and Alacritty roots live under
// %APPDATA%; when that environment variable is unset (should not happen in
// a real user session, but New's home fallback keeps this total) home's
// AppData\Roaming is used instead.
func platformRules(home string) []Rule {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		appData = filepath.Join(home, "AppData", "Roaming")
	}
	return []Rule{
		{
			SourceID: "jetbrains",
			Root:     filepath.Join(appData, "JetBrains"),
			Patterns: []string{"*/colors/*.icls", "*.theme.json"},
		},
		{
			SourceID: "vscode",
			Root:     filepath.Join(home, ".vscode", "extensions"),
			Patterns: []string{"*/themes/*.json"},
		},
		{
			SourceID: "alacritty",
			Root:     filepath.Join(appData, "alacritty"),
			Patterns: []string{"alacritty.toml", "*.toml"},
		},
	}
}

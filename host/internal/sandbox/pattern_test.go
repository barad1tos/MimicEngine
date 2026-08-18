package sandbox

import "testing"

// TestMatchSegments_SpecPatterns pins every allowlist pattern from the
// native-messaging design spec's security envelope against representative
// relative paths, including the two-level JetBrains and VS Code patterns
// that motivate segment-wise (as opposed to substring) matching.
func TestMatchSegments_SpecPatterns(t *testing.T) {
	tests := []struct {
		name    string
		pattern string
		rel     string
		want    bool
	}{
		{"jetbrains icls match", "*/colors/*.icls", "MyPlugin/colors/Dark.icls", true},
		{"jetbrains icls wrong depth", "*/colors/*.icls", "colors/Dark.icls", false},
		{"jetbrains theme json match", "*.theme.json", "Custom.theme.json", true},
		{"jetbrains theme json wrong ext", "*.theme.json", "Custom.json", false},
		{"vscode themes match", "*/themes/*.json", "pub.ext-1.0.0/themes/dark.json", true},
		{"vscode themes wrong depth", "*/themes/*.json", "themes/dark.json", false},
		{"alacritty literal match", "alacritty.toml", "alacritty.toml", true},
		{"alacritty toml glob match", "*.toml", "custom.toml", true},
		{"kitty conf literal", "kitty.conf", "kitty.conf", true},
		{"kitty current theme literal", "current-theme.conf", "current-theme.conf", true},
		{"kitty themes match", "themes/*.conf", "themes/dark.conf", true},
		{"kitty themes wrong ext", "themes/*.conf", "themes/dark.toml", false},
		{"ghostty config literal", "config", "config", true},
		{"ghostty themes match", "themes/*", "themes/dark", true},
		{"ghostty themes no nested escape", "themes/*", "themes/nested/dark", false},
		{"iterm export match", "*.itermcolors", "Solarized.itermcolors", true},
		{"iterm export wrong ext", "*.itermcolors", "Solarized.json", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := matchSegments(tt.pattern, tt.rel); got != tt.want {
				t.Errorf("matchSegments(%q, %q) = %v, want %v", tt.pattern, tt.rel, got, tt.want)
			}
		})
	}
}

func TestValidatePattern(t *testing.T) {
	tests := []struct {
		name    string
		pattern string
		wantErr bool
	}{
		{"simple literal", "alacritty.toml", false},
		{"single wildcard", "*.toml", false},
		{"segment wildcard", "*/colors/*.icls", false},
		{"double star rejected", "**/colors/*.icls", true},
		{"double star trailing", "themes/**", true},
		{"bad glob segment", "[", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validatePattern(tt.pattern)
			if (err != nil) != tt.wantErr {
				t.Errorf("validatePattern(%q) error = %v, wantErr %v", tt.pattern, err, tt.wantErr)
			}
		})
	}
}

//go:build linux

package setup

import "path/filepath"

// platformTargets returns Linux's native-messaging install targets, every
// Dir anchored under home following each browser's XDG config location.
// Arc and Dia have no Linux build, so no targets exist for them here —
// SourceIDs-style omission, mirroring how sandbox/rules_linux.go leaves
// out iTerm for the same reason.
func platformTargets(home string) []Target {
	config := filepath.Join(home, ".config")
	return []Target{
		{
			ID: "chrome", Name: "Google Chrome", Family: Chromium,
			Dir: filepath.Join(config, "google-chrome", "NativeMessagingHosts"),
		},
		{
			ID: "chromium", Name: "Chromium", Family: Chromium,
			Dir: filepath.Join(config, "chromium", "NativeMessagingHosts"),
		},
		{
			ID: "brave", Name: "Brave", Family: Chromium,
			Dir: filepath.Join(config, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
		},
		{
			ID: "edge", Name: "Microsoft Edge", Family: Chromium,
			Dir: filepath.Join(config, "microsoft-edge", "NativeMessagingHosts"),
		},
		{
			ID: "vivaldi", Name: "Vivaldi", Family: Chromium,
			Dir: filepath.Join(config, "vivaldi", "NativeMessagingHosts"),
		},
		{
			ID: "firefox", Name: "Firefox", Family: Firefox,
			Dir: filepath.Join(home, ".mozilla", "native-messaging-hosts"),
		},
	}
}

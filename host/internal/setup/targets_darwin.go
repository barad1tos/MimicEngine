//go:build darwin

package setup

import "path/filepath"

// platformTargets returns macOS's native-messaging install targets, every
// Dir anchored under home.
//
// Detection (targetDetected in detect.go) checks whether Dir already
// exists. For every target but Dia, Dir is the browser's
// NativeMessagingHosts subdirectory — created by the FIRST native-
// messaging host any app installs for that browser, not by the browser
// itself. A machine with no prior native-messaging apps therefore
// under-detects an otherwise-installed browser; `install --browsers`
// exists as the escape hatch for exactly this case (see ResolveCandidates
// in detect.go).
//
// Dia is the one exception: it reads manifests at its Application Support
// ROOT, which IS created by the browser itself on first run — verified
// empirically against 1Password/AdGuard/Claude manifests already present
// there on this machine.
func platformTargets(home string) []Target {
	appSupport := filepath.Join(home, "Library", "Application Support")
	return []Target{
		{
			ID: "chrome", Name: "Google Chrome", Family: Chromium,
			Dir: filepath.Join(appSupport, "Google", "Chrome", "NativeMessagingHosts"),
		},
		{
			ID: "chromium", Name: "Chromium", Family: Chromium,
			Dir: filepath.Join(appSupport, "Chromium", "NativeMessagingHosts"),
		},
		{
			ID: "arc", Name: "Arc", Family: Chromium,
			Dir: filepath.Join(appSupport, "Arc", "User Data", "NativeMessagingHosts"),
		},
		{
			ID: "brave", Name: "Brave", Family: Chromium,
			Dir: filepath.Join(appSupport, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
		},
		{
			ID: "edge", Name: "Microsoft Edge", Family: Chromium,
			Dir: filepath.Join(appSupport, "Microsoft Edge", "NativeMessagingHosts"),
		},
		{
			ID: "vivaldi", Name: "Vivaldi", Family: Chromium,
			Dir: filepath.Join(appSupport, "Vivaldi", "NativeMessagingHosts"),
		},
		{
			ID: "dia", Name: "Dia", Family: Chromium,
			Dir: filepath.Join(appSupport, "Dia"),
		},
		{
			ID: "firefox", Name: "Firefox", Family: Firefox,
			Dir: filepath.Join(appSupport, "Mozilla", "NativeMessagingHosts"),
		},
	}
}

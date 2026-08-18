//go:build windows

package setup

import (
	"os"
	"path/filepath"
)

// platformTargets returns Windows's native-messaging install targets.
//
// Every target's Dir is this app's OWN manifest storage folder under
// %APPDATA%\MimicEngine — unlike the POSIX targets, nothing else ever
// creates or writes there, so (unlike POSIX) Dir carries no detection
// signal; targetDetected checks RegistryPath instead.
//
// RegistryPath is the FULL key Chrome/Firefox actually read a native-
// messaging host from — the browser-specific NativeMessagingHosts key plus
// the host-name leaf, e.g.
// `Software\Google\Chrome\NativeMessagingHosts\`+HostName — whose DEFAULT
// value must hold the manifest's absolute path (see registry.go's
// RegistryWriter doc). That makes Windows detection narrower than the
// POSIX per-family-dir signal: it reflects whether THIS host is already
// registered for that browser, not merely whether the browser supports
// native messaging at all. That's the shape the browser itself reads, so
// it's authoritative here regardless of the detection-breadth tradeoff;
// `install --browsers` remains the escape hatch for a browser this host
// has never been installed into yet (see ResolveCandidates in detect.go).
// Chromium-family browsers all read the same manifest content (one
// --extension-id per install run), so they share one manifest file;
// Firefox gets its own.
//
// Arc and Dia have no verified Windows registry path, so no targets exist
// for them here — mirrors sandbox/rules_windows.go omitting kitty/Ghostty/
// iTerm for having no native Windows build.
func platformTargets(home string) []Target {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		appData = filepath.Join(home, "AppData", "Roaming")
	}

	root := filepath.Join(appData, "MimicEngine")
	chromiumDir := filepath.Join(root, "chromium")
	firefoxDir := filepath.Join(root, "firefox")

	return []Target{
		{
			ID: "chrome", Name: "Google Chrome", Family: Chromium, Dir: chromiumDir,
			RegistryPath: `Software\Google\Chrome\NativeMessagingHosts\` + HostName,
		},
		{
			ID: "chromium", Name: "Chromium", Family: Chromium, Dir: chromiumDir,
			RegistryPath: `Software\Chromium\NativeMessagingHosts\` + HostName,
		},
		{
			ID: "brave", Name: "Brave", Family: Chromium, Dir: chromiumDir,
			RegistryPath: `Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\` + HostName,
		},
		{
			ID: "edge", Name: "Microsoft Edge", Family: Chromium, Dir: chromiumDir,
			RegistryPath: `Software\Microsoft\Edge\NativeMessagingHosts\` + HostName,
		},
		{
			ID: "vivaldi", Name: "Vivaldi", Family: Chromium, Dir: chromiumDir,
			RegistryPath: `Software\Vivaldi\NativeMessagingHosts\` + HostName,
		},
		{
			ID: "firefox", Name: "Firefox", Family: Firefox, Dir: firefoxDir,
			RegistryPath: `Software\Mozilla\NativeMessagingHosts\` + HostName,
		},
	}
}

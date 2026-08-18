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
// signal; targetDetected checks RegistryPath instead, matching the
// registry key another native-messaging app may already have created for
// that browser. Chromium-family browsers all read the same manifest
// content (one --extension-id per install run), so they share one
// manifest file; Firefox gets its own.
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
			RegistryPath: `Software\Google\Chrome\NativeMessagingHosts`,
		},
		{
			ID: "chromium", Name: "Chromium", Family: Chromium, Dir: chromiumDir,
			RegistryPath: `Software\Chromium\NativeMessagingHosts`,
		},
		{
			ID: "brave", Name: "Brave", Family: Chromium, Dir: chromiumDir,
			RegistryPath: `Software\BraveSoftware\Brave-Browser\NativeMessagingHosts`,
		},
		{
			ID: "edge", Name: "Microsoft Edge", Family: Chromium, Dir: chromiumDir,
			RegistryPath: `Software\Microsoft\Edge\NativeMessagingHosts`,
		},
		{
			ID: "vivaldi", Name: "Vivaldi", Family: Chromium, Dir: chromiumDir,
			RegistryPath: `Software\Vivaldi\NativeMessagingHosts`,
		},
		{
			ID: "firefox", Name: "Firefox", Family: Firefox, Dir: firefoxDir,
			RegistryPath: `Software\Mozilla\NativeMessagingHosts`,
		},
	}
}

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
// signal.
//
// RegistryPath is the FULL key Chrome/Firefox actually read a native-
// messaging host from — the browser-specific NativeMessagingHosts key plus
// the host-name leaf, e.g.
// `Software\Google\Chrome\NativeMessagingHosts\`+HostName — whose DEFAULT
// value must hold the manifest's absolute path (see registry.go's
// RegistryWriter doc). It reflects whether THIS host is already registered
// for that browser — Uninstall and Doctor act on it because they care about
// installed state (see Target.RegistryPath).
//
// BrowserMarkerKey is a DIFFERENT signal: whether the BROWSER ITSELF is
// present, independent of whether this host has ever been installed into
// it. Install's candidate detection needs that signal, not RegistryPath —
// keying install detection on our own host key means a fresh machine can
// never bootstrap its first install, since that key by definition does not
// exist yet (task report finding W1). Each Chromium-family browser's
// per-user installer registers a "Program name.exe" entry under
// `Software\Microsoft\Windows\CurrentVersion\App Paths\` — the standard
// Windows mechanism (see Microsoft Learn's "Application Registration" doc)
// letting Explorer/Run-dialog/ShellExecute find an app's exe by name — so
// that entry's presence under HKEY_CURRENT_USER is a reasonable, verified-
// against-documentation proxy for "this browser's per-user install exists".
// Two known gaps, documented rather than hidden (realRegistry's reg.exe
// wrapper only ever queries HKCU — see registry_windows.go):
//   - Microsoft Edge ships as a per-machine Windows component more often
//     than a per-user install, registering its App Paths entry under
//     HKEY_LOCAL_MACHINE instead — invisible to this HKCU-only check. A
//     machine-wide Edge therefore under-detects here; `install --browsers
//     edge` remains the escape hatch (see ResolveInstallCandidates in
//     detect.go).
//   - Chromium (the open-source project, as opposed to Chrome) is normally
//     obtained as an unpacked snapshot with no installer at all, so it
//     never registers an App Paths entry either — BrowserMarkerKey is left
//     empty for it below, same escape hatch applies.
//
// Chromium-family browsers all read the same manifest content (one
// --extension-id per install run), so they share one manifest file;
// Firefox gets its own. Because the file is shared, Uninstall only deletes
// it once every sibling target's own RegistryPath is gone too — see
// anySiblingRegistered in uninstall.go (task report finding W4).
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
	const appPaths = `Software\Microsoft\Windows\CurrentVersion\App Paths\`

	return []Target{
		{
			ID: "chrome", Name: "Google Chrome", Family: Chromium, Dir: chromiumDir,
			RegistryPath:     `Software\Google\Chrome\NativeMessagingHosts\` + HostName,
			BrowserMarkerKey: appPaths + "chrome.exe",
		},
		{
			// No verified App Paths entry: Chromium snapshots ship without an
			// installer, so BrowserMarkerKey stays empty (see the doc above);
			// `install --browsers chromium` is the escape hatch.
			ID: "chromium", Name: "Chromium", Family: Chromium, Dir: chromiumDir,
			RegistryPath: `Software\Chromium\NativeMessagingHosts\` + HostName,
		},
		{
			ID: "brave", Name: "Brave", Family: Chromium, Dir: chromiumDir,
			RegistryPath:     `Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\` + HostName,
			BrowserMarkerKey: appPaths + "brave.exe",
		},
		{
			// BrowserMarkerKey targets the per-user install shape only — see
			// the HKLM caveat above; `install --browsers edge` is the escape
			// hatch for a machine-wide install.
			ID: "edge", Name: "Microsoft Edge", Family: Chromium, Dir: chromiumDir,
			RegistryPath:     `Software\Microsoft\Edge\NativeMessagingHosts\` + HostName,
			BrowserMarkerKey: appPaths + "msedge.exe",
		},
		{
			ID: "vivaldi", Name: "Vivaldi", Family: Chromium, Dir: chromiumDir,
			RegistryPath:     `Software\Vivaldi\NativeMessagingHosts\` + HostName,
			BrowserMarkerKey: appPaths + "vivaldi.exe",
		},
		{
			ID: "firefox", Name: "Firefox", Family: Firefox, Dir: firefoxDir,
			RegistryPath:     `Software\Mozilla\NativeMessagingHosts\` + HostName,
			BrowserMarkerKey: appPaths + "firefox.exe",
		},
	}
}

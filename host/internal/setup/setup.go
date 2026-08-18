// Package setup is the native-messaging host's self-installer: it detects
// which browsers have native-messaging infrastructure on this machine,
// generates the per-family manifest Chrome/Firefox expect, and writes it
// (plus, on Windows, the HKEY_CURRENT_USER registry pointer) to the right
// place. cmd/mimicengine-host's install/uninstall/doctor subcommands are
// thin CLI wrappers around this package — every decision (what counts as
// "detected", what a manifest contains, what "healthy" means) lives here so
// it stays testable without a terminal or a real Windows registry.
package setup

import "path/filepath"

// HostName is the native-messaging host identifier Chrome/Firefox use to
// find this host: the manifest's "name" field, the manifest filename (sans
// extension), and — on Windows — the leaf component of the registry KEY
// Chrome/Firefox read this host from (see Target.RegistryPath) are all
// HostName. The manifest's own path is not stored under a registry value
// named HostName; it lives in that key's DEFAULT (unnamed) value.
const HostName = "com.barad1tos.mimicengine"

// DefaultGeckoID is the extension id Firefox manifests pin via
// allowed_extensions when --gecko-id is not given. It is a fixed constant,
// not detected: the extension side aligns its own manifest key to match.
const DefaultGeckoID = "palette-mimicry@barad1tos.github.io"

// DefaultExtensionID is the Chromium extension id manifests pin via
// allowed_origins when --extension-id is not given. It is the production
// MimicEngine extension's stable id, derived from wxt.config.ts's
// manifest.key (that file documents the derivation: SHA256 of the pinned
// public key's DER bytes, truncated and mapped through Chrome's own
// id alphabet) — not detected, since Chrome assigns this id from the key
// once and it never changes across reinstalls/rebuilds.
const DefaultExtensionID = "blngbjjcheifbhcdiennaldcmlfkhgfb"

// manifestFileName is the filename written under every Target's Dir.
var manifestFileName = HostName + ".json"

// Family distinguishes the two native-messaging manifest shapes: Chromium
// (allowed_origins, keyed to an extension id) and Firefox (allowed_
// extensions, keyed to a gecko id).
type Family int

const (
	// Chromium covers every Chromium-based browser (Chrome, Chromium, Arc,
	// Brave, Edge, Vivaldi, Dia) — they share one manifest shape.
	Chromium Family = iota
	// Firefox is its own family: a different manifest field
	// (allowed_extensions) keyed to a gecko id rather than an extension id.
	Firefox
)

// String renders f for log/error messages ("chromium" or "firefox").
func (f Family) String() string {
	switch f {
	case Chromium:
		return "chromium"
	case Firefox:
		return "firefox"
	default:
		return "unknown"
	}
}

// Target is one browser's native-messaging install point.
type Target struct {
	// ID is the stable identifier install/uninstall/doctor's --browsers
	// flag and doctor's report key on, e.g. "chrome", "dia", "firefox".
	ID string
	// Name is the display name printed to the user, e.g. "Google Chrome".
	Name string
	// Family selects which manifest shape this target expects.
	Family Family
	// Dir is the directory the manifest file (named HostName+".json") is
	// written into. On POSIX this is the browser's own NativeMessagingHosts
	// directory (or, for Dia, its Application Support root — see
	// targets_darwin.go). On Windows it is this app's own manifest storage
	// folder, since nothing else ever reads or creates it — see
	// targets_windows.go for why detection there uses RegistryPath instead.
	Dir string
	// RegistryPath is the HKEY_CURRENT_USER key Chrome/Firefox actually
	// read this host from: the FULL key including the host-name leaf
	// (e.g. `Software\Google\Chrome\NativeMessagingHosts\`+HostName), whose
	// DEFAULT (unnamed) value must hold the manifest's absolute path.
	// Empty on every POSIX target — Windows is the only platform using the
	// registry at all. This is OUR HOST's own presence signal — Uninstall
	// and Doctor act on it because they care about installed state — never
	// the browser's presence signal Install's candidate detection needs
	// (see BrowserMarkerKey).
	RegistryPath string
	// BrowserMarkerKey is a Windows target's proof that the BROWSER ITSELF
	// is present, independent of whether this host has ever been installed
	// into it: e.g. Chrome's own per-user "App Paths" registry entry under
	// HKEY_CURRENT_USER. Install's candidate detection keys on this rather
	// than RegistryPath, which is empty before this host's very first
	// install and would otherwise make plain `install` permanently unable
	// to detect any browser on a fresh machine — see targets_windows.go for
	// the exact keys and their verification caveats. Empty on every POSIX
	// target, where Dir already carries the browser-presence signal (see
	// targets_darwin.go / targets_linux.go).
	BrowserMarkerKey string
}

// ManifestOptions parameterizes the manifest body buildManifest writes:
// which extension is allowed to talk to this host, where the host binary
// lives, and whether to flag the manifest as a dev build.
type ManifestOptions struct {
	// ExtensionID is the Chrome Web Store / unpacked extension id. Required
	// for any Chromium-family target — there is no default (see the
	// design spec's "Install & distribution": the id is not known until
	// the extension's manifest key lands in a later task).
	ExtensionID string
	// GeckoID is the Firefox extension id. Empty means DefaultGeckoID.
	GeckoID string
	// BinaryPath is the manifest's "path" field: where the browser should
	// spawn this host from. Callers resolve a real path (typically
	// os.Executable()'s result) before calling Install — buildManifest
	// treats an empty BinaryPath as a caller bug, not something to default.
	BinaryPath string
	// Dev tags the manifest's description as a dev build, for
	// `install --dev` dogfooding against a locally built binary.
	Dev bool
}

// manifestPath returns the manifest file Install/Uninstall/Doctor read and
// write for t: t.Dir joined with the shared HostName+".json" filename.
func manifestPath(t Target) string {
	return filepath.Join(t.Dir, manifestFileName)
}

// PlatformTargets returns this OS's native-messaging install targets,
// every Dir (and, on Windows, manifest storage folder) anchored at home.
// home is normally os.UserHomeDir()'s result; tests pass a temporary
// directory to exercise detection and writes against a planted fixture
// layout instead of the caller's real home directory.
func PlatformTargets(home string) []Target {
	return platformTargets(home)
}

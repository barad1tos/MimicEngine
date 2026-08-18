package setup

// RegistryWriter abstracts the HKEY_CURRENT_USER registry operations
// Detect, Install, Uninstall, and Doctor need for a Windows Target's
// RegistryPath: whether the host's own native-messaging key already exists
// (detection — the Windows analogue of a POSIX Target's Dir already
// existing), and reading/writing/removing that key's DEFAULT (unnamed)
// value. This is the actual shape Chrome/Firefox read a native-messaging
// host from: RegistryPath is the FULL key including the host-name subkey
// (e.g. `Software\Google\Chrome\NativeMessagingHosts\`+HostName, built in
// targets_windows.go), and the browser reads that key's default value for
// the manifest's absolute path — not a value named after the host under a
// shared parent key. Every value operation below targets that default
// value; there is no named-value variant in this contract.
//
// Exported because NewRegistryWriter's caller lives outside this package
// (cmd/mimicengine-host/main.go): every POSIX Target leaves RegistryPath
// empty, so on those platforms these methods are never invoked in
// production. NewRegistryWriter still returns a working value on every OS:
// stubRegistry (registry_stub.go) on everything but Windows, so main.go
// compiles and runs the same way everywhere; realRegistry
// (registry_windows.go) on Windows itself. Tests use fakeRegistry
// (registry_test.go) to exercise the Windows-shaped code paths —
// detection, install, uninstall, doctor's consistency check — on any
// development machine, mirroring how the sandbox package tests its
// cross-platform matching logic against a synthetic rule table rather than
// the real per-OS one.
type RegistryWriter interface {
	// keyExists reports whether path exists under HKEY_CURRENT_USER.
	keyExists(path string) (bool, error)
	// value reads path's default (unnamed) value. present is false, not an
	// error, when the key or its default value does not exist — an
	// expected outcome for doctor's read side, not a fault.
	value(path string) (data string, present bool, err error)
	// setValue creates path if it does not already exist and writes data
	// into its default (unnamed) value.
	setValue(path, data string) error
	// deleteValue removes path's default value. Deleting a value that is
	// already absent is not an error — uninstall must stay idempotent.
	deleteValue(path string) error
}

package setup

// registryWriter abstracts the HKEY_CURRENT_USER registry operations
// Detect, Install, Uninstall, and Doctor need for a Windows Target's
// RegistryPath: whether a browser's own NativeMessagingHosts key already
// exists (detection — the Windows analogue of a POSIX Target's Dir already
// existing), reading and writing this host's value under it, and removing
// that value again on uninstall.
//
// Every POSIX Target leaves RegistryPath empty, so on those platforms these
// methods are never invoked in production. NewRegistryWriter still returns
// a working value on every OS: stubRegistry (registry_stub.go) on
// everything but Windows, so main.go compiles and runs the same way
// everywhere; realRegistry (registry_windows.go) on Windows itself. Tests
// use fakeRegistry (registry_test.go) to exercise the Windows-shaped code
// paths — detection, install, uninstall, doctor's consistency check — on
// any development machine, mirroring how the sandbox package tests its
// cross-platform matching logic against a synthetic rule table rather than
// the real per-OS one.
type registryWriter interface {
	// keyExists reports whether path exists under HKEY_CURRENT_USER.
	keyExists(path string) (bool, error)
	// value reads name's data under path. present is false, not an error,
	// when the key or the value does not exist — an expected outcome for
	// doctor's read side, not a fault.
	value(path, name string) (data string, present bool, err error)
	// setValue creates path if it does not already exist and writes
	// name=data under it.
	setValue(path, name, data string) error
	// deleteValue removes name under path. Deleting a value that is
	// already absent is not an error — uninstall must stay idempotent.
	deleteValue(path, name string) error
}

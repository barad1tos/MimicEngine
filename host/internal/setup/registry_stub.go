//go:build !windows

package setup

import "errors"

// errRegistryUnsupported is stubRegistry's answer to every call. It is only
// reachable if a Target with a non-empty RegistryPath reaches this build,
// which platformTargets never produces on a non-Windows OS — see
// targets_darwin.go and targets_linux.go.
var errRegistryUnsupported = errors.New("setup: the Windows registry is not available on this platform")

// stubRegistry is the non-Windows RegistryWriter. NewRegistryWriter returns
// it on every OS but Windows, where registry_windows.go's realRegistry
// takes over instead.
type stubRegistry struct{}

func (stubRegistry) keyExists(string) (bool, error) { return false, errRegistryUnsupported }

func (stubRegistry) value(string, string) (string, bool, error) {
	return "", false, errRegistryUnsupported
}

func (stubRegistry) setValue(string, string, string) error { return errRegistryUnsupported }

func (stubRegistry) deleteValue(string, string) error { return errRegistryUnsupported }

// NewRegistryWriter returns this OS's RegistryWriter implementation.
func NewRegistryWriter() RegistryWriter { return stubRegistry{} }

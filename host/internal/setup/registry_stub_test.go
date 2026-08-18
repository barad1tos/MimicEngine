//go:build !windows

package setup

import (
	"errors"
	"testing"
)

// TestStubRegistry_EveryMethodReportsUnsupported proves the non-Windows
// RegistryWriter is a total, honest stub: every method returns
// errRegistryUnsupported rather than silently succeeding or panicking. It
// is only reachable in production if a Target with a non-empty
// RegistryPath ever exists on this OS, which platformTargets never
// produces here — but NewRegistryWriter must still hand back something
// that satisfies RegistryWriter for main.go to compile and run.
func TestStubRegistry_EveryMethodReportsUnsupported(t *testing.T) {
	reg := NewRegistryWriter()

	if _, err := reg.keyExists("Software\\X"); !errors.Is(err, errRegistryUnsupported) {
		t.Errorf("keyExists() error = %v, want errRegistryUnsupported", err)
	}
	if _, _, err := reg.value("Software\\X", "name"); !errors.Is(err, errRegistryUnsupported) {
		t.Errorf("value() error = %v, want errRegistryUnsupported", err)
	}
	if err := reg.setValue("Software\\X", "name", "data"); !errors.Is(err, errRegistryUnsupported) {
		t.Errorf("setValue() error = %v, want errRegistryUnsupported", err)
	}
	if err := reg.deleteValue("Software\\X", "name"); !errors.Is(err, errRegistryUnsupported) {
		t.Errorf("deleteValue() error = %v, want errRegistryUnsupported", err)
	}
}

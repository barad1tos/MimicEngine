package setup

import "errors"

// errBoom is a shared sentinel test doubles return to prove an error from a
// dependency actually propagates, without every test needing its own
// throwaway error value.
var errBoom = errors.New("boom")

// erroringRegistry is a RegistryWriter test double whose value/setValue/
// deleteValue always fail, and whose keyExists fails only when keyExistsErr
// is set. It exercises Install/Uninstall/Doctor's registry-error
// propagation paths without a real Windows registry.
type erroringRegistry struct {
	keyExistsErr error
}

func (r erroringRegistry) keyExists(string) (bool, error) {
	if r.keyExistsErr != nil {
		return false, r.keyExistsErr
	}
	return false, nil
}

func (erroringRegistry) value(string) (string, bool, error) {
	return "", false, errors.New("fake registry: value failed")
}

func (erroringRegistry) setValue(string, string) error {
	return errors.New("fake registry: setValue failed")
}

func (erroringRegistry) deleteValue(string) error {
	return errors.New("fake registry: deleteValue failed")
}

// fakeRegistry is a RegistryWriter test double backed by an in-memory map,
// keyed by the registry path itself — RegistryWriter's contract has exactly
// one value per key (the key's own default value), so no composite key is
// needed. It lets tests exercise Detect/Install/Uninstall/Doctor's
// Windows-target code paths (registry-based detection, and value
// read/write/delete) on any development machine, without a real Windows
// registry — mirroring how the sandbox package's tests inject a synthetic
// rule table instead of depending on the real per-OS layout.
type fakeRegistry struct {
	values map[string]string
}

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{values: map[string]string{}}
}

func (r *fakeRegistry) keyExists(path string) (bool, error) {
	_, ok := r.values[path]
	return ok, nil
}

func (r *fakeRegistry) value(path string) (string, bool, error) {
	data, ok := r.values[path]
	return data, ok, nil
}

func (r *fakeRegistry) setValue(path, data string) error {
	r.values[path] = data
	return nil
}

func (r *fakeRegistry) deleteValue(path string) error {
	delete(r.values, path)
	return nil
}

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

func (erroringRegistry) value(string, string) (string, bool, error) {
	return "", false, errors.New("fake registry: value failed")
}

func (erroringRegistry) setValue(string, string, string) error {
	return errors.New("fake registry: setValue failed")
}

func (erroringRegistry) deleteValue(string, string) error {
	return errors.New("fake registry: deleteValue failed")
}

// fakeRegistry is a RegistryWriter test double backed by an in-memory map,
// keyed by "path\x00name". It lets tests exercise Detect/Install/Uninstall/
// Doctor's Windows-target code paths (registry-based detection, and value
// read/write/delete) on any development machine, without a real Windows
// registry — mirroring how the sandbox package's tests inject a synthetic
// rule table instead of depending on the real per-OS layout.
type fakeRegistry struct {
	values map[string]string
}

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{values: map[string]string{}}
}

func fakeRegistryKey(path, name string) string {
	return path + "\x00" + name
}

func (r *fakeRegistry) keyExists(path string) (bool, error) {
	prefix := path + "\x00"
	for k := range r.values {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			return true, nil
		}
	}
	return false, nil
}

func (r *fakeRegistry) value(path, name string) (string, bool, error) {
	data, ok := r.values[fakeRegistryKey(path, name)]
	return data, ok, nil
}

func (r *fakeRegistry) setValue(path, name, data string) error {
	r.values[fakeRegistryKey(path, name)] = data
	return nil
}

func (r *fakeRegistry) deleteValue(path, name string) error {
	delete(r.values, fakeRegistryKey(path, name))
	return nil
}

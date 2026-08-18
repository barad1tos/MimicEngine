package ops

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"

	"github.com/barad1tos/MimicEngine/host/internal/protocol"
	"github.com/barad1tos/MimicEngine/host/internal/sandbox"
)

// stubFileProvider gives an embedder no-op Enumerate and Open
// implementations so a fake built to test one op (ping's SourceIDs, here)
// still satisfies the full fileProvider interface Serve/handleFrame
// require. Tests that actually exercise enumerate or read define their own
// dedicated fakes against the narrower enumerator/opener interfaces instead
// of using these.
type stubFileProvider struct{}

func (stubFileProvider) Enumerate(int, int) (sandbox.EnumerateResult, error) {
	return sandbox.EnumerateResult{}, nil
}

func (stubFileProvider) Open(string) (*os.File, error) {
	return nil, errors.New("stubFileProvider: Open not implemented")
}

// fakeSources is a minimal sourceLister test double.
type fakeSources struct {
	stubFileProvider
	ids []string
}

func (f fakeSources) SourceIDs() []string { return f.ids }

// panickingSources simulates a handler-internal panic (e.g. an unexpected
// nil dereference deep in Task 2's sandbox.Box) so the serve loop's panic
// recovery can be exercised without a real fault.
type panickingSources struct{ stubFileProvider }

func (panickingSources) SourceIDs() []string { panic("boom: simulated handler panic") }

func TestHandlePing(t *testing.T) {
	sources := fakeSources{ids: []string{"jetbrains", "vscode"}}
	req := protocol.Request{ID: 7, Op: "ping"}

	got := handlePing(req, "1.2.3", sources)

	want := pingEnvelope{
		ID:              7,
		OK:              true,
		Version:         "1.2.3",
		ProtocolVersion: ProtocolVersion,
		SourceIDs:       []string{"jetbrains", "vscode"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("handlePing() = %+v, want %+v", got, want)
	}
}

func TestHandlePing_EmptySources(t *testing.T) {
	got := handlePing(protocol.Request{ID: 1}, "dev", fakeSources{ids: []string{}})
	if len(got.SourceIDs) != 0 {
		t.Fatalf("SourceIDs = %v, want empty", got.SourceIDs)
	}
}

// TestHandlePing_JSONShape is the ping golden test: it pins the exact wire
// shape and field order of a ping response against the protocol design spec.
func TestHandlePing_JSONShape(t *testing.T) {
	got := handlePing(protocol.Request{ID: 3}, "1.0.0", fakeSources{ids: []string{"a"}})

	data, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	const want = `{"id":3,"ok":true,"version":"1.0.0","protocolVersion":1,"sourceIds":["a"]}`
	if string(data) != want {
		t.Fatalf("json = %s, want %s", data, want)
	}
}

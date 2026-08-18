package ops

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/barad1tos/MimicEngine/host/internal/protocol"
)

// fakeSources is a minimal sourceLister test double.
type fakeSources struct{ ids []string }

func (f fakeSources) SourceIDs() []string { return f.ids }

// panickingSources simulates a handler-internal panic (e.g. an unexpected
// nil dereference deep in Task 2's sandbox.Box) so the serve loop's panic
// recovery can be exercised without a real fault.
type panickingSources struct{}

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

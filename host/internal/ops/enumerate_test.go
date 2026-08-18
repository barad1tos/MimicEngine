package ops

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/barad1tos/MimicEngine/host/internal/protocol"
	"github.com/barad1tos/MimicEngine/host/internal/sandbox"
)

// fakeEnumerator is a minimal enumerator test double. It also records the
// budget/maxResults arguments it was called with, so tests can pin that
// handleEnumerate actually threads the spec's caps through rather than
// hardcoding its own.
type fakeEnumerator struct {
	result sandbox.EnumerateResult
	err    error

	gotBudget, gotMaxResults int
}

func (f *fakeEnumerator) Enumerate(budget, maxResults int) (sandbox.EnumerateResult, error) {
	f.gotBudget, f.gotMaxResults = budget, maxResults
	return f.result, f.err
}

func TestHandleEnumerate_Success(t *testing.T) {
	files := &fakeEnumerator{result: sandbox.EnumerateResult{Files: []sandbox.FileInfo{
		{Path: "/home/user/.config/alacritty/alacritty.toml", Size: 42, ModifiedAt: "2026-08-18T00:00:00Z", SourceID: "alacritty"},
	}}}

	got := handleEnumerate(protocol.Request{ID: 7}, files)

	want := enumerateEnvelope{
		ID: 7,
		OK: true,
		Files: []enumerateFileEnvelope{
			{Path: "/home/user/.config/alacritty/alacritty.toml", Size: 42, ModifiedAt: "2026-08-18T00:00:00Z", SourceID: "alacritty"},
		},
		Truncated: false,
	}
	if diff, ok := got.(enumerateEnvelope); !ok || diff.ID != want.ID || diff.OK != want.OK || diff.Truncated != want.Truncated || len(diff.Files) != 1 || diff.Files[0] != want.Files[0] {
		t.Fatalf("handleEnumerate() = %+v, want %+v", got, want)
	}
}

// TestHandleEnumerate_JSONShape pins the exact wire field names the spec
// requires (path/size/modifiedAt/sourceId/truncated) and that an empty
// result set serializes files as [] rather than JSON null.
func TestHandleEnumerate_JSONShape(t *testing.T) {
	got := handleEnumerate(protocol.Request{ID: 1}, &fakeEnumerator{})

	data, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	const want = `{"id":1,"ok":true,"files":[],"truncated":false}`
	if string(data) != want {
		t.Fatalf("json = %s, want %s", data, want)
	}
}

// TestHandleEnumerate_TruncatedPassesThrough pins that a truncated scan
// (walk budget or result cap cut short — see sandbox.EnumerateResult) is
// reported on the wire, not silently dropped between sandbox.Box.Enumerate
// and the enumerate response envelope.
func TestHandleEnumerate_TruncatedPassesThrough(t *testing.T) {
	files := &fakeEnumerator{result: sandbox.EnumerateResult{Truncated: true}}

	got := handleEnumerate(protocol.Request{ID: 1}, files)

	env, ok := got.(enumerateEnvelope)
	if !ok {
		t.Fatalf("handleEnumerate() = %T, want enumerateEnvelope", got)
	}
	if !env.Truncated {
		t.Fatal("enumerateEnvelope.Truncated = false, want true")
	}
}

func TestHandleEnumerate_UsesSpecCaps(t *testing.T) {
	files := &fakeEnumerator{}
	handleEnumerate(protocol.Request{ID: 1}, files)

	if files.gotBudget != walkBudget {
		t.Fatalf("Enumerate called with budget=%d, want walkBudget=%d", files.gotBudget, walkBudget)
	}
	if files.gotMaxResults != maxResults {
		t.Fatalf("Enumerate called with maxResults=%d, want %d", files.gotMaxResults, maxResults)
	}
}

func TestHandleEnumerate_ErrorMapsToInternalError(t *testing.T) {
	files := &fakeEnumerator{err: errors.New("boom: walk failed")}

	got := handleEnumerate(protocol.Request{ID: 3}, files)

	env, ok := got.(errorEnvelope)
	if !ok {
		t.Fatalf("handleEnumerate() = %T, want errorEnvelope", got)
	}
	if env.OK {
		t.Fatal("errorEnvelope.OK = true, want false")
	}
	if env.Error.Code != codeInternalError {
		t.Fatalf("errorEnvelope.Error.Code = %q, want %q", env.Error.Code, codeInternalError)
	}
	if env.ID != 3 {
		t.Fatalf("errorEnvelope.ID = %d, want 3", env.ID)
	}
}

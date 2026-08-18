package ops

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/barad1tos/MimicEngine/host/internal/protocol"
	"github.com/barad1tos/MimicEngine/host/internal/sandbox"
)

// dispatchFake is a fileProvider whose Enumerate and Open return
// distinguishable, caller-supplied data, so a Serve-level test can prove
// handleFrame's switch actually routed each op to its own handler — not,
// say, an "enumerate" request accidentally landing on handleRead (a
// copy-paste swap in the switch would compile and pass every handler-level
// unit test, since those call handleEnumerate/handleRead directly).
type dispatchFake struct {
	ids              []string
	enumerateResults []sandbox.FileInfo
	openFile         *os.File
}

func (d *dispatchFake) SourceIDs() []string { return d.ids }

func (d *dispatchFake) Enumerate(int, int) (sandbox.EnumerateResult, error) {
	return sandbox.EnumerateResult{Files: d.enumerateResults}, nil
}

func (d *dispatchFake) Open(string) (*os.File, error) { return d.openFile, nil }

// TestServe_EnumerateAndReadDispatchEndToEnd drives Serve with real framed
// requests for both ops and inspects the raw wire response for each op's
// distinguishing field (enumerate has "files", read has "content"), so a
// dispatch-arm swap or op-string typo in handleFrame's switch would fail
// this test even though it wouldn't fail any handleEnumerate/handleRead
// unit test.
func TestServe_EnumerateAndReadDispatchEndToEnd(t *testing.T) {
	contentPath := filepath.Join(t.TempDir(), "theme.toml")
	if err := os.WriteFile(contentPath, []byte("theme = 1"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	openedFile, err := os.Open(contentPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = openedFile.Close() })

	provider := &dispatchFake{
		ids: []string{"test-source"},
		enumerateResults: []sandbox.FileInfo{
			{Path: "/enumerated/path.toml", Size: 9, ModifiedAt: "2026-08-18T00:00:00Z", SourceID: "test-source"},
		},
		openFile: openedFile,
	}

	var in bytes.Buffer
	inWriter := protocol.NewWriter(&in)
	if err := inWriter.Send(protocol.Request{ID: 1, Op: "enumerate"}); err != nil {
		t.Fatalf("building fixture: %v", err)
	}
	if err := inWriter.Send(protocol.Request{ID: 2, Op: "read", Path: contentPath}); err != nil {
		t.Fatalf("building fixture: %v", err)
	}

	out := drainServe(t, &in, inWriter, provider)

	enumerateFrame := readGenericFrame(t, out)
	files, hasFiles := enumerateFrame["files"]
	if !hasFiles {
		t.Fatalf("enumerate response missing \"files\": %v", enumerateFrame)
	}
	if _, hasContent := enumerateFrame["content"]; hasContent {
		t.Fatalf("enumerate response has \"content\" — the read handler's shape leaked into the enumerate op: %v", enumerateFrame)
	}
	fileList, ok := files.([]any)
	if !ok || len(fileList) != 1 {
		t.Fatalf("enumerate \"files\" = %v, want exactly 1 entry", files)
	}
	entry, ok := fileList[0].(map[string]any)
	if !ok || entry["path"] != "/enumerated/path.toml" || entry["sourceId"] != "test-source" {
		t.Fatalf("enumerate files[0] = %v, want the fake enumerator's own entry", fileList[0])
	}

	readFrame := readGenericFrame(t, out)
	content, hasContent := readFrame["content"]
	if !hasContent {
		t.Fatalf("read response missing \"content\": %v", readFrame)
	}
	if _, hasFiles := readFrame["files"]; hasFiles {
		t.Fatalf("read response has \"files\" — the enumerate handler's shape leaked into the read op: %v", readFrame)
	}
	if content != "theme = 1" {
		t.Fatalf("read content = %v, want %q", content, "theme = 1")
	}
}

// TestServe_RealSandboxBoxSourceIDsFlowThroughPing wires a real
// *sandbox.Box (constructed exactly as main.go's run() does, minus the real
// $HOME) through Serve and checks ping's sourceIds is non-empty. This is
// GOOS-agnostic: every platform's rules table (rules_darwin.go,
// rules_linux.go, rules_windows.go) is non-empty regardless of what exists
// on disk under the given home — SourceIDs() reads the rule table, not the
// filesystem — so this proves the real Box's identifiers actually reach the
// wire on any OS this package's tests run on, without a platform branch.
func TestServe_RealSandboxBoxSourceIDsFlowThroughPing(t *testing.T) {
	box, err := sandbox.New(t.TempDir())
	if err != nil {
		t.Fatalf("sandbox.New: %v", err)
	}

	var in bytes.Buffer
	inWriter := protocol.NewWriter(&in)
	if err := inWriter.Send(protocol.Request{ID: 1, Op: "ping"}); err != nil {
		t.Fatalf("building fixture: %v", err)
	}

	out := drainServe(t, &in, inWriter, box)

	frame, readErr := protocol.ReadFrame(out, protocol.MaxFrameLen)
	if readErr != nil {
		t.Fatalf("ReadFrame: %v", readErr)
	}
	var env pingEnvelope
	if err := json.Unmarshal(frame, &env); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !env.OK {
		t.Fatalf("ping envelope OK = false, want true: %+v", env)
	}
	if len(env.SourceIDs) == 0 {
		t.Fatal("ping sourceIds is empty — want a real *sandbox.Box's rule table (non-empty on every supported OS) to reach the wire")
	}
}

// drainServe closes inWriter (finalizing the fixture already written into
// in), runs Serve against in with a fresh out buffer, and closes the
// resulting writer — the close-run-close sequence every dispatch test in
// this file needs before it can read response frames.
func drainServe(t *testing.T, in *bytes.Buffer, inWriter *protocol.Writer, sources fileProvider) *bytes.Buffer {
	t.Helper()

	if err := inWriter.Close(); err != nil {
		t.Fatalf("closing fixture writer: %v", err)
	}

	var out bytes.Buffer
	outWriter := protocol.NewWriter(&out)
	if err := Serve(in, outWriter, "1.0.0-test", sources); err != nil {
		t.Fatalf("Serve() = %v, want nil on clean EOF", err)
	}
	if err := outWriter.Close(); err != nil {
		t.Fatalf("closing out writer: %v", err)
	}
	return &out
}

// readGenericFrame reads exactly one frame from buf and decodes it into a
// generic map, so a test can assert on field presence/absence to catch a
// wrong-shape response (e.g. an enumerate response accidentally carrying
// read's "content" field) rather than only checking the fields it expects.
func readGenericFrame(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()

	frame, err := protocol.ReadFrame(buf, protocol.MaxFrameLen)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}

	var generic map[string]any
	if err := json.Unmarshal(frame, &generic); err != nil {
		t.Fatalf("frame did not decode as a JSON object: %v", err)
	}
	return generic
}

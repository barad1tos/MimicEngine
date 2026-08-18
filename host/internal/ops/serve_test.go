package ops

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/barad1tos/MimicEngine/host/internal/protocol"
)

func TestHandleFrame_UnsupportedOp(t *testing.T) {
	var buf bytes.Buffer
	out := protocol.NewWriter(&buf)
	t.Cleanup(func() { _ = out.Close() })

	payload, err := json.Marshal(protocol.Request{ID: 5, Op: "enumerate"})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	if err := handleFrame(payload, out, "dev", fakeSources{}); err != nil {
		t.Fatalf("handleFrame: %v", err)
	}

	envelope := readErrorEnvelope(t, &buf)
	if envelope.OK {
		t.Fatal("envelope.OK = true, want false")
	}
	if envelope.ID != 5 {
		t.Fatalf("envelope.ID = %d, want 5", envelope.ID)
	}
	if envelope.Error.Code != codeUnsupportedOp {
		t.Fatalf("envelope.Error.Code = %q, want %q", envelope.Error.Code, codeUnsupportedOp)
	}
}

func TestHandleFrame_MalformedJSON_IDRecoverable(t *testing.T) {
	var buf bytes.Buffer
	out := protocol.NewWriter(&buf)
	t.Cleanup(func() { _ = out.Close() })

	// "op" has the wrong JSON type: the full Request decode fails, but the
	// id, which appears before the bad field, is still recoverable.
	payload := []byte(`{"id":11,"op":123}`)

	if err := handleFrame(payload, out, "dev", fakeSources{}); err != nil {
		t.Fatalf("handleFrame: %v", err)
	}

	envelope := readErrorEnvelope(t, &buf)
	if envelope.OK {
		t.Fatal("envelope.OK = true, want false")
	}
	if envelope.ID != 11 {
		t.Fatalf("envelope.ID = %d, want 11 (recovered from malformed payload)", envelope.ID)
	}
	if envelope.Error.Code != codeBadRequest {
		t.Fatalf("envelope.Error.Code = %q, want %q", envelope.Error.Code, codeBadRequest)
	}
}

func TestHandleFrame_MalformedJSON_IDUnrecoverable(t *testing.T) {
	var buf bytes.Buffer
	out := protocol.NewWriter(&buf)
	t.Cleanup(func() { _ = out.Close() })

	payload := []byte(`{not valid json`)

	if err := handleFrame(payload, out, "dev", fakeSources{}); err != nil {
		t.Fatalf("handleFrame: %v", err)
	}

	envelope := readErrorEnvelope(t, &buf)
	if envelope.OK {
		t.Fatal("envelope.OK = true, want false")
	}
	if envelope.ID != 0 {
		t.Fatalf("envelope.ID = %d, want 0", envelope.ID)
	}
	if envelope.Error.Code != codeBadRequest {
		t.Fatalf("envelope.Error.Code = %q, want %q", envelope.Error.Code, codeBadRequest)
	}
}

func TestHandleFrame_PanicRecovered(t *testing.T) {
	var buf bytes.Buffer
	out := protocol.NewWriter(&buf)
	t.Cleanup(func() { _ = out.Close() })

	payload, err := json.Marshal(protocol.Request{ID: 9, Op: "ping"})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	err = handleFrame(payload, out, "dev", panickingSources{})
	if err == nil {
		t.Fatal("handleFrame() = nil error, want the recovered panic surfaced as an error")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Fatalf("error %v does not mention the panic value", err)
	}

	envelope := readErrorEnvelope(t, &buf)
	if envelope.OK {
		t.Fatal("envelope.OK = true, want false for a recovered panic")
	}
	if envelope.ID != 9 {
		t.Fatalf("envelope.ID = %d, want 9 (the original request's id)", envelope.ID)
	}
	if envelope.Error.Code != codeBadRequest {
		t.Fatalf("envelope.Error.Code = %q, want %q", envelope.Error.Code, codeBadRequest)
	}
}

func TestServe_ProcessesFramesUntilEOF(t *testing.T) {
	var in bytes.Buffer
	inWriter := protocol.NewWriter(&in)
	if err := inWriter.Send(protocol.Request{ID: 1, Op: "ping"}); err != nil {
		t.Fatalf("building fixture: %v", err)
	}
	if err := inWriter.Send(protocol.Request{ID: 2, Op: "enumerate"}); err != nil {
		t.Fatalf("building fixture: %v", err)
	}
	if err := inWriter.Close(); err != nil {
		t.Fatalf("closing fixture writer: %v", err)
	}

	var out bytes.Buffer
	outWriter := protocol.NewWriter(&out)

	err := Serve(&in, outWriter, "1.0.0-test", fakeSources{ids: []string{"jetbrains"}})
	if closeErr := outWriter.Close(); closeErr != nil {
		t.Fatalf("closing out writer: %v", closeErr)
	}
	if err != nil {
		t.Fatalf("Serve() = %v, want nil on clean EOF", err)
	}

	frame1, readErr := protocol.ReadFrame(&out, protocol.MaxFrameLen)
	if readErr != nil {
		t.Fatalf("ReadFrame (ping response): %v", readErr)
	}
	var pingEnv pingEnvelope
	if err := json.Unmarshal(frame1, &pingEnv); err != nil {
		t.Fatalf("Unmarshal ping response: %v", err)
	}
	if !pingEnv.OK || pingEnv.ID != 1 {
		t.Fatalf("ping response = %+v, want OK=true ID=1", pingEnv)
	}

	frame2, readErr := protocol.ReadFrame(&out, protocol.MaxFrameLen)
	if readErr != nil {
		t.Fatalf("ReadFrame (error response): %v", readErr)
	}
	var errEnv errorEnvelope
	if err := json.Unmarshal(frame2, &errEnv); err != nil {
		t.Fatalf("Unmarshal error response: %v", err)
	}
	if errEnv.OK || errEnv.ID != 2 || errEnv.Error.Code != codeUnsupportedOp {
		t.Fatalf("error response = %+v, want OK=false ID=2 Code=%q", errEnv, codeUnsupportedOp)
	}

	if _, err := protocol.ReadFrame(&out, protocol.MaxFrameLen); !errors.Is(err, io.EOF) {
		t.Fatalf("expected exactly two response frames, got trailing data (err=%v)", err)
	}
}

func TestServe_PanicEndsLoop(t *testing.T) {
	var in bytes.Buffer
	inWriter := protocol.NewWriter(&in)
	if err := inWriter.Send(protocol.Request{ID: 1, Op: "ping"}); err != nil {
		t.Fatalf("building fixture: %v", err)
	}
	if err := inWriter.Close(); err != nil {
		t.Fatalf("closing fixture writer: %v", err)
	}

	var out bytes.Buffer
	outWriter := protocol.NewWriter(&out)
	t.Cleanup(func() { _ = outWriter.Close() })

	err := Serve(&in, outWriter, "1.0.0-test", panickingSources{})
	if err == nil {
		t.Fatal("Serve() = nil error, want a non-nil error after a recovered handler panic")
	}
}

// readErrorEnvelope reads exactly one frame from buf and decodes it as an
// errorEnvelope, failing the test on any error.
func readErrorEnvelope(t *testing.T, buf *bytes.Buffer) errorEnvelope {
	t.Helper()

	frame, err := protocol.ReadFrame(buf, protocol.MaxFrameLen)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}

	var envelope errorEnvelope
	if err := json.Unmarshal(frame, &envelope); err != nil {
		t.Fatalf("frame did not decode as an error envelope: %v", err)
	}
	return envelope
}

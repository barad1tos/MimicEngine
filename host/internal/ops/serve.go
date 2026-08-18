package ops

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/barad1tos/MimicEngine/host/internal/protocol"
)

// Error codes used by this task's handlers. The protocol's full vocabulary
// (path-denied, not-found, too-large, bad-request, unsupported-op) has no
// dedicated "internal error" entry, so a recovered handler panic is also
// reported as bad-request: from the caller's perspective the request could
// not be fulfilled, which is the closest fit in the fixed vocabulary.
const (
	codeBadRequest    = "bad-request"
	codeUnsupportedOp = "unsupported-op"
)

// errorEnvelope is the wire shape of a failed response.
type errorEnvelope struct {
	ID    int64              `json:"id"`
	OK    bool               `json:"ok"`
	Error protocol.ErrorBody `json:"error"`
}

func newErrorEnvelope(id int64, code, message string) errorEnvelope {
	return errorEnvelope{
		ID:    id,
		OK:    false,
		Error: protocol.ErrorBody{Code: code, Message: message},
	}
}

// Serve reads one native-messaging frame at a time from in, dispatches each
// to its handler, and writes exactly one response frame via out per request.
// It returns nil when in reaches a clean EOF (the browser closed the pipe)
// and a non-nil, wrapped error for any other frame read failure or a
// recovered handler panic — both end the loop, and the caller (main) is
// expected to exit non-zero so the browser respawns the host on next
// connect.
func Serve(in io.Reader, out *protocol.Writer, version string, sources sourceLister) error {
	for {
		payload, err := protocol.ReadFrame(in, protocol.MaxFrameLen)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("reading frame: %w", err)
		}

		if err := handleFrame(payload, out, version, sources); err != nil {
			return err
		}
	}
}

// handleFrame decodes and handles exactly one request frame. A panic raised
// while handling is recovered here — the only recover point in the serve
// loop — reported to the caller as a best-effort error frame, and
// re-surfaced as the returned error so Serve ends the loop.
func handleFrame(payload []byte, out *protocol.Writer, version string, sources sourceLister) (err error) {
	var requestID int64 // best-effort correlation id, used if a handler panics

	defer func() {
		if r := recover(); r != nil {
			sendErr := out.Send(newErrorEnvelope(requestID, codeBadRequest, fmt.Sprintf("panic: %v", r)))
			err = fmt.Errorf("recovered panic in handler: %v (error frame send: %w)", r, sendErr)
		}
	}()

	var req protocol.Request
	if unmarshalErr := json.Unmarshal(payload, &req); unmarshalErr != nil {
		requestID = bestEffortID(payload)
		return out.Send(newErrorEnvelope(requestID, codeBadRequest, unmarshalErr.Error()))
	}
	requestID = req.ID

	switch req.Op {
	case "ping":
		return out.Send(handlePing(req, version, sources))
	default:
		return out.Send(newErrorEnvelope(req.ID, codeUnsupportedOp, fmt.Sprintf("unsupported op %q", req.Op)))
	}
}

// bestEffortID recovers the id field from a payload whose full Request shape
// failed to decode, so a bad-request response can still echo the caller's
// id. It returns 0 when even that cannot be extracted.
func bestEffortID(payload []byte) int64 {
	var idOnly struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(payload, &idOnly); err != nil {
		return 0
	}
	return idOnly.ID
}

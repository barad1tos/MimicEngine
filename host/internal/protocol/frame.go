package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// MaxFrameLen is the largest payload ReadFrame accepts, matching Chrome's
// documented native-messaging limit for messages sent to the browser.
const MaxFrameLen = 1 << 20

// lengthPrefixSize is the byte width of a frame's length prefix.
const lengthPrefixSize = 4

// ErrFrameTooLarge indicates a frame announced a payload length beyond the
// caller-supplied limit.
var ErrFrameTooLarge = errors.New("protocol: frame exceeds size limit")

// ReadFrame reads one native-messaging frame from r: a 4-byte little-endian
// length prefix followed by exactly that many bytes of JSON payload.
//
// When the announced length exceeds maxLen, ReadFrame returns
// ErrFrameTooLarge without allocating a buffer sized to that length or
// reading any further bytes from r — the check runs strictly before
// allocation. A clean EOF before any byte of the length prefix is read is
// returned as io.EOF, signaling the far end closed the stream between
// frames. Every other short read — a truncated prefix, or the stream ending
// anywhere at or after the prefix but before the announced payload is fully
// delivered — is a mid-frame protocol violation, not a clean shutdown, and
// is reported wrapped around io.ErrUnexpectedEOF (this includes the case
// where zero payload bytes follow a fully-read prefix announcing a non-zero
// length: io.ReadFull's own contract would otherwise surface that as a bare
// io.EOF, which callers must not mistake for a clean stream close).
func ReadFrame(r io.Reader, maxLen int) ([]byte, error) {
	var lengthBytes [lengthPrefixSize]byte
	if _, err := io.ReadFull(r, lengthBytes[:]); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.EOF
		}
		return nil, fmt.Errorf("reading frame length: %w", err)
	}

	length := binary.LittleEndian.Uint32(lengthBytes[:])
	if int64(length) > int64(maxLen) {
		return nil, fmt.Errorf("%w: announced %d bytes exceeds %d byte limit", ErrFrameTooLarge, length, maxLen)
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		if errors.Is(err, io.EOF) {
			// The prefix already committed to `length` payload bytes (length
			// is > 0 here: io.ReadFull never errors against a zero-length
			// buffer). A bare io.EOF means the peer closed the stream before
			// sending any of them — classify it as the mid-frame violation
			// it is, not the clean-shutdown-between-frames case above.
			return nil, fmt.Errorf("reading frame payload: %w", io.ErrUnexpectedEOF)
		}
		return nil, fmt.Errorf("reading frame payload: %w", err)
	}

	return payload, nil
}

// frameMessage prepends a little-endian length prefix to payload, producing
// the wire format ReadFrame consumes. It rejects payloads that ReadFrame
// could never read back under MaxFrameLen.
func frameMessage(payload []byte) ([]byte, error) {
	if len(payload) > MaxFrameLen {
		return nil, fmt.Errorf("%w: message is %d bytes exceeds %d byte limit", ErrFrameTooLarge, len(payload), MaxFrameLen)
	}

	frame := make([]byte, lengthPrefixSize+len(payload))
	binary.LittleEndian.PutUint32(frame[:lengthPrefixSize], uint32(len(payload)))
	copy(frame[lengthPrefixSize:], payload)
	return frame, nil
}

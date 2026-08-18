package ops

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"unicode/utf8"

	"github.com/barad1tos/MimicEngine/host/internal/protocol"
	"github.com/barad1tos/MimicEngine/host/internal/sandbox"
)

// maxReadBytes is the spec's per-file read cap. A file at or under this size
// reads in full; a file over it is rejected as too-large rather than
// silently truncated.
const maxReadBytes = 2 * 1024 * 1024 // 2MB

// errTooLarge signals that readCapped found more than its limit's worth of
// bytes without reaching EOF.
var errTooLarge = errors.New("ops: content exceeds the read cap")

// opener returns a verified, opened file for a caller-supplied path.
// *sandbox.Box satisfies this; its Open already performs every allowlist
// and TOCTOU check read needs, so handleRead only has to map the result.
type opener interface {
	Open(path string) (*os.File, error)
}

// readEnvelope is the wire shape of a successful read response.
type readEnvelope struct {
	ID      int64  `json:"id"`
	OK      bool   `json:"ok"`
	Content string `json:"content"`
}

// handleRead returns the UTF-8 text content of req.Path, verified and
// opened through files. See mapOpenErrorCode for how sandbox.Open's denial
// reasons map to wire error codes, and readCapped for the too-large cap.
// Content that is not valid UTF-8 is rejected as codeBadRequest: the read
// op's contract is a text file, and silently replacing invalid bytes with
// U+FFFD (json.Marshal's default behavior) would mangle binary content
// without telling the caller. This reading is the implementer's own call,
// not spec text — flagged in the task report for the reviewer to confirm.
func handleRead(req protocol.Request, files opener) any {
	if req.Path == "" {
		return newErrorEnvelope(req.ID, codeBadRequest, "read requires a non-empty path")
	}

	f, err := files.Open(req.Path)
	if err != nil {
		return newErrorEnvelope(req.ID, mapOpenErrorCode(err), err.Error())
	}
	defer func() { _ = f.Close() }()

	data, err := readCapped(f, maxReadBytes)
	if err != nil {
		if errors.Is(err, errTooLarge) {
			return newErrorEnvelope(req.ID, codeTooLarge, fmt.Sprintf("file exceeds the %d byte read cap", maxReadBytes))
		}
		return newErrorEnvelope(req.ID, codeInternalError, err.Error())
	}

	if !utf8.Valid(data) {
		return newErrorEnvelope(req.ID, codeBadRequest, "file is not valid utf-8")
	}

	return readEnvelope{ID: req.ID, OK: true, Content: string(data)}
}

// mapOpenErrorCode translates a sandbox.Open failure into the protocol's
// error vocabulary. sandbox.Open wraps every rejection reason so both
// checks below work through errors.Is/errors.As-compatible unwrapping:
// ErrDenied covers everything the allowlist itself rejects (outside every
// root, pattern mismatch, TOCTOU swap), and the underlying os.Open/
// filepath.EvalSymlinks failure for a path that simply is not there wraps
// fs.ErrNotExist. Anything else (permission errors, I/O failures) is a
// host-side problem, mapped to codeInternalError.
func mapOpenErrorCode(err error) string {
	switch {
	case errors.Is(err, sandbox.ErrDenied):
		return codePathDenied
	case errors.Is(err, fs.ErrNotExist):
		return codeNotFound
	default:
		return codeInternalError
	}
}

// readCapped reads at most limit+1 bytes from r without buffering anything
// beyond that: io.LimitReader caps how much io.ReadAll can ever pull, so a
// file far larger than limit is never fully read into memory just to be
// rejected. It returns errTooLarge once more than limit bytes were present.
func readCapped(r io.Reader, limit int) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, int64(limit)+1))
	if err != nil {
		return nil, fmt.Errorf("reading capped content: %w", err)
	}
	if len(data) > limit {
		return nil, errTooLarge
	}
	return data, nil
}

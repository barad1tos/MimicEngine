package ops

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/barad1tos/MimicEngine/host/internal/protocol"
	"github.com/barad1tos/MimicEngine/host/internal/sandbox"
)

// fakeOpener is a minimal opener test double: it returns a pre-opened file
// (or an error) regardless of the requested path, so tests can drive
// handleRead's mapping logic without a real sandbox.Box.
type fakeOpener struct {
	file *os.File
	err  error
}

func (f fakeOpener) Open(string) (*os.File, error) { return f.file, f.err }

// poisonOpener fails the test if Open is ever called — used to assert a
// guard clause short-circuits before touching the sandbox.
type poisonOpener struct{ t *testing.T }

func (p poisonOpener) Open(path string) (*os.File, error) {
	p.t.Fatalf("Open(%q) called, want handleRead to reject before opening", path)
	return nil, nil
}

func mustOpenTempFile(t *testing.T, content []byte) *os.File {
	t.Helper()
	path := filepath.Join(t.TempDir(), "content")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return f
}

func TestHandleRead_Success(t *testing.T) {
	f := mustOpenTempFile(t, []byte("hello, world"))

	got := handleRead(protocol.Request{ID: 4, Path: "/whatever"}, fakeOpener{file: f})

	env, ok := got.(readEnvelope)
	if !ok {
		t.Fatalf("handleRead() = %T, want readEnvelope", got)
	}
	if !env.OK || env.ID != 4 || env.Content != "hello, world" {
		t.Fatalf("handleRead() = %+v, want OK=true ID=4 Content=%q", env, "hello, world")
	}
}

func TestHandleRead_EmptyPathIsBadRequest(t *testing.T) {
	got := handleRead(protocol.Request{ID: 1, Path: ""}, poisonOpener{t: t})

	env, ok := got.(errorEnvelope)
	if !ok {
		t.Fatalf("handleRead() = %T, want errorEnvelope", got)
	}
	if env.Error.Code != codeBadRequest {
		t.Fatalf("errorEnvelope.Error.Code = %q, want %q", env.Error.Code, codeBadRequest)
	}
}

func TestHandleRead_DeniedPathMapsToPathDenied(t *testing.T) {
	got := handleRead(protocol.Request{ID: 2, Path: "/outside"}, fakeOpener{
		err: fmt.Errorf("%q is not allow-listed: %w", "/outside", sandbox.ErrDenied),
	})

	env, ok := got.(errorEnvelope)
	if !ok {
		t.Fatalf("handleRead() = %T, want errorEnvelope", got)
	}
	if env.Error.Code != codePathDenied {
		t.Fatalf("errorEnvelope.Error.Code = %q, want %q", env.Error.Code, codePathDenied)
	}
}

func TestHandleRead_MissingPathMapsToNotFound(t *testing.T) {
	got := handleRead(protocol.Request{ID: 5, Path: "/nope"}, fakeOpener{
		err: fmt.Errorf("resolving %q: %w", "/nope", fs.ErrNotExist),
	})

	env, ok := got.(errorEnvelope)
	if !ok {
		t.Fatalf("handleRead() = %T, want errorEnvelope", got)
	}
	if env.Error.Code != codeNotFound {
		t.Fatalf("errorEnvelope.Error.Code = %q, want %q", env.Error.Code, codeNotFound)
	}
}

func TestHandleRead_OtherOpenErrorMapsToInternalError(t *testing.T) {
	got := handleRead(protocol.Request{ID: 6, Path: "/somewhere"}, fakeOpener{
		err: errors.New("permission denied"),
	})

	env, ok := got.(errorEnvelope)
	if !ok {
		t.Fatalf("handleRead() = %T, want errorEnvelope", got)
	}
	if env.Error.Code != codeInternalError {
		t.Fatalf("errorEnvelope.Error.Code = %q, want %q", env.Error.Code, codeInternalError)
	}
}

// TestHandleRead_ExactlyAtCapSucceeds pins the boundary: a file whose size
// equals the cap exactly must succeed, not be rejected as too-large.
func TestHandleRead_ExactlyAtCapSucceeds(t *testing.T) {
	content := bytes.Repeat([]byte("a"), maxReadBytes)
	f := mustOpenTempFile(t, content)

	got := handleRead(protocol.Request{ID: 8, Path: "/whatever"}, fakeOpener{file: f})

	env, ok := got.(readEnvelope)
	if !ok {
		t.Fatalf("handleRead() = %T (%+v), want readEnvelope for a file exactly at the cap", got, got)
	}
	if len(env.Content) != maxReadBytes {
		t.Fatalf("len(Content) = %d, want %d", len(env.Content), maxReadBytes)
	}
}

// TestHandleRead_OneByteOverCapIsTooLarge pins the other side of the same
// boundary with real (non-sparse) content.
func TestHandleRead_OneByteOverCapIsTooLarge(t *testing.T) {
	content := bytes.Repeat([]byte("a"), maxReadBytes+1)
	f := mustOpenTempFile(t, content)

	got := handleRead(protocol.Request{ID: 9, Path: "/whatever"}, fakeOpener{file: f})

	env, ok := got.(errorEnvelope)
	if !ok {
		t.Fatalf("handleRead() = %T, want errorEnvelope", got)
	}
	if env.Error.Code != codeTooLarge {
		t.Fatalf("errorEnvelope.Error.Code = %q, want %q", env.Error.Code, codeTooLarge)
	}
}

// TestHandleRead_SparseLargeFileIsTooLargeAndCloses uses Truncate to grow a
// file well past the cap without writing real bytes to disk (the brief's
// suggested sparse-file approach), and additionally verifies handleRead
// closed the descriptor: a second read against the same *os.File after
// handleRead returns must fail, since nothing else in this test touches it.
func TestHandleRead_SparseLargeFileIsTooLargeAndCloses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sparse")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := f.Truncate(maxReadBytes + 10); err != nil {
		t.Fatalf("Truncate: %v", err)
	}

	got := handleRead(protocol.Request{ID: 10, Path: "/whatever"}, fakeOpener{file: f})

	env, ok := got.(errorEnvelope)
	if !ok {
		t.Fatalf("handleRead() = %T, want errorEnvelope", got)
	}
	if env.Error.Code != codeTooLarge {
		t.Fatalf("errorEnvelope.Error.Code = %q, want %q", env.Error.Code, codeTooLarge)
	}

	if _, err := f.Stat(); err == nil {
		t.Fatal("f.Stat() succeeded after handleRead, want the descriptor closed on the too-large path")
	}
}

func TestHandleRead_InvalidUTF8IsBadRequest(t *testing.T) {
	f := mustOpenTempFile(t, []byte{0xff, 0xfe, 0x00, 0x01})

	got := handleRead(protocol.Request{ID: 11, Path: "/whatever"}, fakeOpener{file: f})

	env, ok := got.(errorEnvelope)
	if !ok {
		t.Fatalf("handleRead() = %T, want errorEnvelope", got)
	}
	if env.Error.Code != codeBadRequest {
		t.Fatalf("errorEnvelope.Error.Code = %q, want %q", env.Error.Code, codeBadRequest)
	}
}

// TestHandleRead_ClosesFileOnSuccess pins that handleRead's deferred Close
// runs on the success path too, not just on error returns.
func TestHandleRead_ClosesFileOnSuccess(t *testing.T) {
	f := mustOpenTempFile(t, []byte("ok"))

	handleRead(protocol.Request{ID: 12, Path: "/whatever"}, fakeOpener{file: f})

	if _, err := f.Stat(); err == nil {
		t.Fatal("f.Stat() succeeded after handleRead, want the descriptor closed on the success path too")
	}
}

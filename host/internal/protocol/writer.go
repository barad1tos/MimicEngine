package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// errWriterClosed is returned by Send once Close has been called.
var errWriterClosed = errors.New("protocol: writer closed")

// writeRequest carries one framed message to the writer goroutine along with
// a channel to report the outcome of the underlying io.Writer.Write back to
// the caller that sent it.
type writeRequest struct {
	frame  []byte
	result chan error
}

// Writer serializes every write to an underlying io.Writer through a single
// goroutine, so concurrent callers can never interleave partial frames on
// stdout. Construct exactly one Writer per output stream (typically
// os.Stdout) and route every response and event through it — nothing else
// may write to that stream.
type Writer struct {
	requests chan writeRequest
	done     chan struct{}

	mu       sync.Mutex // guards closed and the inFlight registration below
	closed   bool
	inFlight sync.WaitGroup

	closeOnce sync.Once
}

// NewWriter starts the writer goroutine that owns w and returns a Writer
// ready to accept Send calls. Callers must eventually call Close to stop the
// goroutine.
func NewWriter(w io.Writer) *Writer {
	writer := &Writer{
		requests: make(chan writeRequest),
		done:     make(chan struct{}),
	}
	go writer.run(w)
	return writer
}

// run is the single goroutine permitted to touch w; it serializes every
// frame handed to it via requests and reports each write's outcome back to
// the sender.
func (wr *Writer) run(w io.Writer) {
	defer close(wr.done)
	for req := range wr.requests {
		_, err := w.Write(req.frame)
		req.result <- err
	}
}

// Send marshals v to JSON, frames it per the native-messaging wire format,
// and hands it to the writer goroutine. It is safe to call concurrently from
// multiple goroutines: frames from concurrent callers are handed to the
// underlying writer one at a time and never interleave. Send blocks until
// the frame has actually been written and returns that write's error, so
// callers observe real transport failures (e.g. a broken stdout pipe)
// instead of silently losing them.
func (wr *Writer) Send(v any) error {
	if !wr.enter() {
		return errWriterClosed
	}
	defer wr.inFlight.Done()

	payload, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshaling response: %w", err)
	}

	frame, err := frameMessage(payload)
	if err != nil {
		return fmt.Errorf("framing response: %w", err)
	}

	result := make(chan error, 1)
	wr.requests <- writeRequest{frame: frame, result: result}
	return <-result
}

// enter registers one in-flight Send against a closing Writer, atomically
// with the closed check, so Close can never observe zero in-flight sends
// while one is still racing to register.
func (wr *Writer) enter() bool {
	wr.mu.Lock()
	defer wr.mu.Unlock()
	if wr.closed {
		return false
	}
	wr.inFlight.Add(1)
	return true
}

// Close waits for every in-flight Send to finish, then drains the request
// channel and stops the writer goroutine. It is safe to call more than once;
// only the first call does the work. Close never returns a non-nil error
// itself — write failures are reported by the Send call they belong to.
func (wr *Writer) Close() error {
	wr.closeOnce.Do(func() {
		wr.mu.Lock()
		wr.closed = true
		wr.mu.Unlock()

		wr.inFlight.Wait()
		close(wr.requests)
	})
	<-wr.done
	return nil
}

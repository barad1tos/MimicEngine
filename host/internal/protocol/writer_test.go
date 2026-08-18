package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
)

type pingLikeMessage struct {
	ID int64 `json:"id"`
}

func TestWriter_SendRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	t.Cleanup(func() { _ = w.Close() })

	if err := w.Send(pingLikeMessage{ID: 42}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	got, err := ReadFrame(&buf, MaxFrameLen)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}

	var decoded pingLikeMessage
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded.ID != 42 {
		t.Fatalf("decoded.ID = %d, want 42", decoded.ID)
	}
}

func TestWriter_SendMultipleFramesPreserveOrder(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	t.Cleanup(func() { _ = w.Close() })

	for i := int64(1); i <= 3; i++ {
		if err := w.Send(pingLikeMessage{ID: i}); err != nil {
			t.Fatalf("Send(%d): %v", i, err)
		}
	}

	for want := int64(1); want <= 3; want++ {
		frame, err := ReadFrame(&buf, MaxFrameLen)
		if err != nil {
			t.Fatalf("ReadFrame: %v", err)
		}
		var decoded pingLikeMessage
		if err := json.Unmarshal(frame, &decoded); err != nil {
			t.Fatalf("Unmarshal: %v", err)
		}
		if decoded.ID != want {
			t.Fatalf("decoded.ID = %d, want %d", decoded.ID, want)
		}
	}
}

func TestWriter_CloseIsIdempotent(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	if err := w.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestWriter_SendAfterCloseReturnsError(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	err := w.Send(pingLikeMessage{ID: 1})
	if !errors.Is(err, errWriterClosed) {
		t.Fatalf("Send() after Close error = %v, want errWriterClosed", err)
	}
}

// TestWriter_ConcurrentSendsDoNotInterleave proves the writer's monopoly
// over the underlying io.Writer: many goroutines calling Send concurrently
// must still produce a byte stream where every frame parses back as exactly
// one intact, valid JSON message — never a mix of partial frames from two
// senders. Run with -race; the single writer goroutine is what makes
// concurrent access to buf safe despite bytes.Buffer itself not being
// concurrency-safe.
func TestWriter_ConcurrentSendsDoNotInterleave(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	const goroutines = 8
	const perGoroutine = 50

	type message struct {
		Sender int    `json:"sender"`
		Seq    int    `json:"seq"`
		Filler string `json:"filler"`
	}

	var wg sync.WaitGroup
	wg.Add(goroutines)
	for g := 0; g < goroutines; g++ {
		go func(sender int) {
			defer wg.Done()
			for seq := 0; seq < perGoroutine; seq++ {
				msg := message{Sender: sender, Seq: seq, Filler: strings.Repeat("x", 200)}
				if err := w.Send(msg); err != nil {
					t.Errorf("Send(sender=%d, seq=%d): %v", sender, seq, err)
				}
			}
		}(g)
	}
	wg.Wait()

	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	type key struct{ sender, seq int }
	seen := make(map[key]bool)
	count := 0
	for {
		frame, err := ReadFrame(&buf, MaxFrameLen)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("ReadFrame at frame %d: %v", count, err)
		}

		var decoded message
		if err := json.Unmarshal(frame, &decoded); err != nil {
			t.Fatalf("frame %d is not a single valid JSON message: %v (bytes: %q)", count, err, frame)
		}

		k := key{decoded.Sender, decoded.Seq}
		if seen[k] {
			t.Fatalf("duplicate message sender=%d seq=%d — frames corrupted", decoded.Sender, decoded.Seq)
		}
		seen[k] = true
		count++
	}

	if want := goroutines * perGoroutine; count != want {
		t.Fatalf("got %d frames, want %d", count, want)
	}
}

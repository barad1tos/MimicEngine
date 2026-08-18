package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"testing"
)

func TestReadFrame_RoundTrip(t *testing.T) {
	payload := []byte(`{"id":1,"op":"ping"}`)

	frame, err := frameMessage(payload)
	if err != nil {
		t.Fatalf("frameMessage: %v", err)
	}

	got, err := ReadFrame(bytes.NewReader(frame), MaxFrameLen)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("ReadFrame() = %q, want %q", got, payload)
	}
}

func TestReadFrame_EmptyPayload(t *testing.T) {
	frame, err := frameMessage(nil)
	if err != nil {
		t.Fatalf("frameMessage: %v", err)
	}

	got, err := ReadFrame(bytes.NewReader(frame), MaxFrameLen)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("ReadFrame() = %q, want empty", got)
	}
}

func TestReadFrame_CleanEOFBeforeAnyByte(t *testing.T) {
	_, err := ReadFrame(bytes.NewReader(nil), MaxFrameLen)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("ReadFrame() error = %v, want io.EOF", err)
	}
}

func TestReadFrame_TruncatedLengthPrefix(t *testing.T) {
	_, err := ReadFrame(bytes.NewReader([]byte{0x01, 0x02}), MaxFrameLen)
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("ReadFrame() error = %v, want wrapped io.ErrUnexpectedEOF", err)
	}
}

func TestReadFrame_TruncatedPayload(t *testing.T) {
	var header [lengthPrefixSize]byte
	binary.LittleEndian.PutUint32(header[:], 10)
	data := append(header[:], []byte("abc")...) // announces 10 bytes, supplies 3

	_, err := ReadFrame(bytes.NewReader(data), MaxFrameLen)
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("ReadFrame() error = %v, want wrapped io.ErrUnexpectedEOF", err)
	}
}

// TestReadFrame_PeerDiesAfterPrefixBeforePayload covers the boundary where
// the length prefix arrives fully (announcing a non-zero length) but the
// stream ends before even one payload byte follows. io.ReadFull's own
// contract reports that as a bare io.EOF; ReadFrame must not let that bare
// io.EOF pass through, because a caller checking errors.Is(err, io.EOF) (as
// Serve does, to detect a clean shutdown between frames) would otherwise
// mistake a peer that died mid-frame for one that closed the stream
// cleanly.
func TestReadFrame_PeerDiesAfterPrefixBeforePayload(t *testing.T) {
	var header [lengthPrefixSize]byte
	binary.LittleEndian.PutUint32(header[:], 5) // announces 5 payload bytes that never arrive

	_, err := ReadFrame(bytes.NewReader(header[:]), MaxFrameLen)

	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("ReadFrame() error = %v, want errors.Is(..., io.ErrUnexpectedEOF)", err)
	}
	if errors.Is(err, io.EOF) {
		t.Fatalf("ReadFrame() error = %v classifies as io.EOF — a caller would wrongly treat a mid-frame peer death as a clean shutdown", err)
	}
}

func TestReadFrame_ExactlyAtLimitSucceeds(t *testing.T) {
	payload := bytes.Repeat([]byte("a"), 64)
	frame, err := frameMessage(payload)
	if err != nil {
		t.Fatalf("frameMessage: %v", err)
	}

	got, err := ReadFrame(bytes.NewReader(frame), len(payload))
	if err != nil {
		t.Fatalf("ReadFrame() with maxLen == payload length: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("ReadFrame() = %q, want %q", got, payload)
	}
}

func TestReadFrame_OversizeFrameRejectedBeforeAllocation(t *testing.T) {
	var header [lengthPrefixSize]byte
	binary.LittleEndian.PutUint32(header[:], math.MaxUint32)

	// This reader serves the 4-byte length prefix once and fails the test if
	// ReadFrame ever calls Read again — proving the oversize check runs
	// strictly before any attempt to allocate or read the announced payload.
	r := &singleReadThenFatal{t: t, data: header[:]}

	_, err := ReadFrame(r, MaxFrameLen)
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("ReadFrame() error = %v, want ErrFrameTooLarge", err)
	}
}

// singleReadThenFatal serves data on its first Read call and fails the test
// on any subsequent Read call.
type singleReadThenFatal struct {
	t      *testing.T
	data   []byte
	served bool
}

func (r *singleReadThenFatal) Read(p []byte) (int, error) {
	if r.served {
		r.t.Fatalf("ReadFrame read past the length prefix for an oversize frame")
		return 0, io.EOF
	}
	r.served = true
	n := copy(p, r.data)
	return n, nil
}

func TestFrameMessage_RejectsOversizePayload(t *testing.T) {
	payload := make([]byte, MaxFrameLen+1)

	_, err := frameMessage(payload)
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("frameMessage() error = %v, want ErrFrameTooLarge", err)
	}
}

func FuzzReadFrame(f *testing.F) {
	seedPayload := []byte(`{"id":1,"op":"ping"}`)
	seedFrame, err := frameMessage(seedPayload)
	if err != nil {
		f.Fatalf("frameMessage: %v", err)
	}
	f.Add(seedFrame)
	f.Add([]byte{})
	f.Add([]byte{0x01, 0x02})

	var oversizeHeader [lengthPrefixSize]byte
	binary.LittleEndian.PutUint32(oversizeHeader[:], math.MaxUint32)
	f.Add(oversizeHeader[:])

	f.Fuzz(func(t *testing.T, data []byte) {
		got, err := ReadFrame(bytes.NewReader(data), MaxFrameLen)
		if err != nil {
			return
		}
		if len(got) > MaxFrameLen {
			t.Fatalf("ReadFrame returned %d bytes without error, exceeding MaxFrameLen %d", len(got), MaxFrameLen)
		}
	})
}

// Package protocol implements the Chrome native-messaging wire format: a
// little-endian uint32 length prefix followed by that many bytes of JSON,
// over stdio. It owns framing (ReadFrame) and the single stdout-monopoly
// writer (Writer) that every response and event flows through.
package protocol

// Request is the JSON envelope every native-messaging call sends to the host.
type Request struct {
	ID   int64  `json:"id"`
	Op   string `json:"op"`
	Path string `json:"path,omitempty"`
}

// ErrorBody carries a machine-checkable error code alongside a human-readable
// message. Codes are drawn from the protocol's fixed vocabulary:
// path-denied, not-found, too-large, bad-request, unsupported-op,
// internal-error.
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

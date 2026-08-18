// Package ops implements the native-messaging host's request handlers and
// the stdio serve loop that dispatches to them.
package ops

import "github.com/barad1tos/MimicEngine/host/internal/protocol"

// ProtocolVersion is the native-messaging wire protocol version this host
// speaks. The extension refuses to talk to a host reporting a mismatch.
const ProtocolVersion = 1

// sourceLister reports the allow-listed source identifiers a ping response
// advertises. Task 2's *sandbox.Box satisfies this; Serve accepts the
// interface so this package stays buildable ahead of that package existing.
type sourceLister interface {
	SourceIDs() []string
}

// pingEnvelope is the wire shape of a successful ping response.
type pingEnvelope struct {
	ID              int64    `json:"id"`
	OK              bool     `json:"ok"`
	Version         string   `json:"version"`
	ProtocolVersion int      `json:"protocolVersion"`
	SourceIDs       []string `json:"sourceIds"`
}

// handlePing answers a ping request with the host's version, protocol
// version, and the caller-supplied sourceLister's current source ids.
func handlePing(req protocol.Request, version string, sources sourceLister) pingEnvelope {
	return pingEnvelope{
		ID:              req.ID,
		OK:              true,
		Version:         version,
		ProtocolVersion: ProtocolVersion,
		SourceIDs:       sources.SourceIDs(),
	}
}

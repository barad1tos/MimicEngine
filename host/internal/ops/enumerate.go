package ops

import (
	"github.com/barad1tos/MimicEngine/host/internal/protocol"
	"github.com/barad1tos/MimicEngine/host/internal/sandbox"
)

// Spec-mandated caps for the enumerate op: walkBudget bounds how many
// filesystem entries a single Enumerate call visits before giving up, and
// maxResults bounds how many matches it reports back to the caller.
const (
	walkBudget = 10000
	maxResults = 500
)

// enumerator reports the allow-listed files handleEnumerate can list.
// *sandbox.Box satisfies this.
type enumerator interface {
	Enumerate(budget, maxResults int) ([]sandbox.FileInfo, error)
}

// enumerateFileEnvelope is one file's wire shape inside an enumerate
// response.
type enumerateFileEnvelope struct {
	Path       string `json:"path"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
	SourceID   string `json:"sourceId"`
}

// enumerateEnvelope is the wire shape of a successful enumerate response.
type enumerateEnvelope struct {
	ID    int64                   `json:"id"`
	OK    bool                    `json:"ok"`
	Files []enumerateFileEnvelope `json:"files"`
}

// handleEnumerate lists every allow-listed file files can discover, capped
// by the spec's walk-budget and result-count limits. Enumerate has no
// per-path denial semantics — every file it reports already passed the
// allowlist, so any error it returns is a host-side problem (e.g. a broken
// filesystem walk) and maps to codeInternalError rather than
// codePathDenied. The return type is `any`, matching every other dispatch
// arm in handleFrame: a success and a failure are genuinely different wire
// shapes (enumerateEnvelope vs errorEnvelope), and out.Send already accepts
// either.
func handleEnumerate(req protocol.Request, files enumerator) any {
	results, err := files.Enumerate(walkBudget, maxResults)
	if err != nil {
		return newErrorEnvelope(req.ID, codeInternalError, err.Error())
	}

	wire := make([]enumerateFileEnvelope, 0, len(results))
	for _, f := range results {
		wire = append(wire, enumerateFileEnvelope{
			Path:       f.Path,
			Size:       f.Size,
			ModifiedAt: f.ModifiedAt,
			SourceID:   f.SourceID,
		})
	}

	return enumerateEnvelope{ID: req.ID, OK: true, Files: wire}
}

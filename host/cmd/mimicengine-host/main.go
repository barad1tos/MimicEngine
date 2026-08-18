// Command mimicengine-host is the native-messaging host Chrome/Firefox spawn
// to let the MimicEngine extension discover and read theme files from disk.
package main

import (
	"log"
	"os"

	"github.com/barad1tos/MimicEngine/host/internal/ops"
	"github.com/barad1tos/MimicEngine/host/internal/protocol"
)

// version is stamped at build time via -ldflags "-X main.version=...".
var version = "dev"

// noSources is a temporary stand-in for the sandbox package's Box, which
// does not exist yet. It reports no source ids until that package lands and
// this wiring is replaced with a real *sandbox.Box.
type noSources struct{}

func (noSources) SourceIDs() []string { return []string{} }

func main() {
	if err := run(); err != nil {
		log.Println(err)
		os.Exit(1)
	}
}

func run() error {
	writer := protocol.NewWriter(os.Stdout)
	defer func() { _ = writer.Close() }()

	return ops.Serve(os.Stdin, writer, version, noSources{})
}

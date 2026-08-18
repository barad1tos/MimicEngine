// Command mimicengine-host is the native-messaging host Chrome/Firefox spawn
// to let the MimicEngine extension discover and read theme files from disk.
package main

import (
	"fmt"
	"log"
	"os"

	"github.com/barad1tos/MimicEngine/host/internal/ops"
	"github.com/barad1tos/MimicEngine/host/internal/protocol"
	"github.com/barad1tos/MimicEngine/host/internal/sandbox"
)

// version is stamped at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(); err != nil {
		log.Println(err)
		os.Exit(1)
	}
}

func run() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolving user home directory: %w", err)
	}

	box, err := sandbox.New(home)
	if err != nil {
		return fmt.Errorf("building sandbox: %w", err)
	}

	writer := protocol.NewWriter(os.Stdout)
	defer func() { _ = writer.Close() }()

	return ops.Serve(os.Stdin, writer, version, box)
}

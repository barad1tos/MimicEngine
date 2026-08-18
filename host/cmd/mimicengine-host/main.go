// Command mimicengine-host is the native-messaging host Chrome/Firefox spawn
// to let the MimicEngine extension discover and read theme files from disk.
// Run with install, uninstall, doctor, or version, it manages its own
// native-messaging manifests or reports its build version; run with any
// other argv shape — including what the browser itself passes when it
// spawns this host (a Chromium extension origin, or a Firefox manifest-path
// + extension-id pair) — it speaks the framed stdio protocol the browser
// expects.
package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/barad1tos/MimicEngine/host/internal/ops"
	"github.com/barad1tos/MimicEngine/host/internal/protocol"
	"github.com/barad1tos/MimicEngine/host/internal/sandbox"
	"github.com/barad1tos/MimicEngine/host/internal/setup"
)

// version is stamped at build time via -ldflags "-X main.version=...".
var version = "dev"

// errDoctorFailed is runDoctor's exit-nonzero signal: at least one target's
// report came back StatusFail. It carries no extra detail because
// runDoctor already printed every finding before returning it.
var errDoctorFailed = errors.New("doctor found one or more problems")

func main() {
	if err := run(os.Args[1:]); err != nil {
		log.Println(err)
		os.Exit(1)
	}
}

// run dispatches os.Args[1:] to one of the setup subcommands on an EXACT
// match of args[0], or to the stdio serve loop for anything else.
//
// "anything else" is deliberate, not a fallback for an unrecognized
// subcommand: Chrome and Firefox spawn this host with their OWN argv, never
// empty — Chrome passes the extension's origin ("chrome-extension://<id>/"
// and sometimes "--parent-window=..."), Firefox passes the manifest path
// followed by the extension id. Neither shape matches a setup subcommand,
// so treating any non-matching args[0] as an error (as an early version of
// this dispatch did) made serve() unreachable from every real browser
// launch — see task-4-report.md's Fix round 3, finding C1. Only the four
// literal subcommand names below are ever treated as commands; every other
// argv shape — including a genuine typo — falls through to serve.
//
// run is separated from main so tests can drive it with synthetic argv
// without exiting the test binary.
func run(args []string) error {
	if len(args) > 0 {
		switch args[0] {
		case "-h", "--help", "help":
			return runHelp(os.Stdout)
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolving user home directory: %w", err)
	}

	if len(args) > 0 {
		switch args[0] {
		case "install":
			return runInstall(args[1:], os.Stdin, os.Stdout, home)
		case "uninstall":
			return runUninstall(args[1:], os.Stdin, os.Stdout, home)
		case "doctor":
			return runDoctor(args[1:], os.Stdout, home)
		case "version":
			return runVersion(os.Stdout)
		}
	}

	return serve(home)
}

// runHelp writes the subcommand usage summary to stdout. "-h", "--help",
// and "help" are matched exactly, the same way the four setup subcommands
// are: see run's doc comment for why every other argv shape — including a
// genuine typo — falls through to serve instead of landing here.
func runHelp(stdout io.Writer) error {
	const usage = `mimicengine-host is the native-messaging host the MimicEngine browser
extension spawns to read theme files from disk.

Subcommands:
  install    write this host's native-messaging manifest for detected browsers
  uninstall  remove this host's native-messaging manifest
  doctor     report each browser's native-messaging install health
  version    print the build version and exit

Run with no subcommand to serve the native-messaging protocol on stdio --
this is how Chrome/Firefox invoke the host; it is not meant to be run this
way by hand.
`
	_, err := fmt.Fprint(stdout, usage)
	return err
}

// serve runs the native-messaging stdio loop Chrome/Firefox spawn the host
// with: no subcommand, no confirmation, framed JSON on stdin/stdout until
// the browser closes the pipe. It logs one line to stderr before entering
// the loop — the wire protocol itself is silent, so without this a human
// who lands here (a typo'd subcommand, manual testing) sees nothing at all;
// the native-messaging spec permits stderr logging since the browser never
// reads it as protocol data.
func serve(home string) error {
	box, err := sandbox.New(home)
	if err != nil {
		return fmt.Errorf("building sandbox: %w", err)
	}

	writer := protocol.NewWriter(os.Stdout)
	defer func() { _ = writer.Close() }()

	_, _ = fmt.Fprintln(os.Stderr, "mimicengine-host: serving native messaging on stdio")

	return ops.Serve(os.Stdin, writer, version, box)
}

// runVersion writes the build-time version stamped via
// -ldflags "-X main.version=..." to stdout, unadorned so scripts can
// consume it directly.
func runVersion(stdout io.Writer) error {
	_, err := fmt.Fprintln(stdout, version)
	return err
}

// runInstall parses install's flags, resolves which browsers to target,
// confirms with the user (unless --yes), and writes their native-messaging
// manifests. stdin/stdout are injected so tests exercise the full
// detect-confirm-write flow without touching the real console.
func runInstall(args []string, stdin io.Reader, stdout io.Writer, home string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	yes := fs.Bool("yes", false, "install without an interactive confirmation prompt")
	browsers := fs.String("browsers", "", "comma-separated browser ids to install (default: every detected browser)")
	dev := fs.Bool("dev", false, "tag the manifest description as a dev build")
	binary := fs.String("binary", "", "override the manifest's binary path (default: this executable's own path; a relative value is resolved to absolute)")
	extensionID := fs.String("extension-id", "", "Chromium extension id (required for any Chromium-family browser)")
	geckoID := fs.String("gecko-id", "", "Firefox extension id (default: "+setup.DefaultGeckoID+")")
	if err := fs.Parse(args); err != nil {
		return err
	}

	targets := setup.PlatformTargets(home)
	reg := setup.NewRegistryWriter()

	candidates, err := setup.ResolveCandidates(targets, *browsers, reg)
	if err != nil {
		return err
	}
	if len(candidates) == 0 {
		_, _ = fmt.Fprintln(stdout, "no browsers detected; pass --browsers to target one explicitly")
		return nil
	}

	printTargetList(stdout, "detected", candidates)

	if !*yes {
		proceed, err := confirmYesNo(stdin, stdout, "proceed with install? [y/N] ")
		if err != nil {
			return err
		}
		if !proceed {
			_, _ = fmt.Fprintln(stdout, "aborted")
			return nil
		}
	}

	binaryPath := *binary
	if binaryPath == "" {
		resolved, err := os.Executable()
		if err != nil {
			return fmt.Errorf("resolving current executable: %w", err)
		}
		binaryPath = resolved
	}
	// Chrome/Firefox require an absolute "path" in the manifest; a relative
	// --binary would otherwise land in the manifest verbatim and resolve
	// against whatever directory the browser happens to spawn the host
	// from, not the directory install was run in.
	absBinaryPath, err := filepath.Abs(binaryPath)
	if err != nil {
		return fmt.Errorf("resolving absolute path for %q: %w", binaryPath, err)
	}
	binaryPath = absBinaryPath

	result, err := setup.Install(candidates, setup.ManifestOptions{
		ExtensionID: *extensionID,
		GeckoID:     *geckoID,
		BinaryPath:  binaryPath,
		Dev:         *dev,
	}, reg)
	if err != nil {
		return err
	}

	printTargetList(stdout, "installed", result.Written)
	return nil
}

// runUninstall parses uninstall's flags, resolves which browsers to target
// (the same detection Install uses), confirms with the user (unless
// --yes), and removes their native-messaging manifests.
func runUninstall(args []string, stdin io.Reader, stdout io.Writer, home string) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	yes := fs.Bool("yes", false, "uninstall without an interactive confirmation prompt")
	browsers := fs.String("browsers", "", "comma-separated browser ids to uninstall (default: every detected browser)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	targets := setup.PlatformTargets(home)
	reg := setup.NewRegistryWriter()

	candidates, err := setup.ResolveCandidates(targets, *browsers, reg)
	if err != nil {
		return err
	}
	if len(candidates) == 0 {
		_, _ = fmt.Fprintln(stdout, "no browsers detected; nothing to uninstall")
		return nil
	}

	printTargetList(stdout, "detected", candidates)

	if !*yes {
		proceed, err := confirmYesNo(stdin, stdout, "proceed with uninstall? [y/N] ")
		if err != nil {
			return err
		}
		if !proceed {
			_, _ = fmt.Fprintln(stdout, "aborted")
			return nil
		}
	}

	result, err := setup.Uninstall(candidates, reg)
	if err != nil {
		return err
	}

	printTargetList(stdout, "removed", result.Removed)
	return nil
}

// runDoctor parses doctor's flags and prints one health line per target
// (every known browser by default, or --browsers' subset). It returns
// errDoctorFailed — main's cue to exit(1) — when any target's check came
// back StatusFail; StatusNotInstalled is not a failure.
func runDoctor(args []string, stdout io.Writer, home string) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	browsers := fs.String("browsers", "", "comma-separated browser ids to check (default: every known browser)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	targets := setup.PlatformTargets(home)
	if *browsers != "" {
		resolved, err := setup.ResolveTargets(targets, *browsers)
		if err != nil {
			return err
		}
		targets = resolved
	}

	reports := setup.DoctorReport(targets, setup.NewRegistryWriter())

	failed := false
	for _, r := range reports {
		_, _ = fmt.Fprintf(stdout, "%s (%s): %s\n", r.Target.Name, r.Target.ID, r.Detail)
		if r.Status == setup.StatusFail {
			failed = true
		}
	}
	if failed {
		return errDoctorFailed
	}
	return nil
}

// printTargetList prints label followed by one indented "Name (id)" line
// per target. It prints nothing when targets is empty, so callers can call
// it unconditionally after an operation that may have written/removed zero
// targets.
func printTargetList(w io.Writer, label string, targets []setup.Target) {
	if len(targets) == 0 {
		return
	}
	_, _ = fmt.Fprintf(w, "%s:\n", label)
	for _, t := range targets {
		_, _ = fmt.Fprintf(w, "  %s (%s)\n", t.Name, t.ID)
	}
}

// confirmYesNo prints prompt to stdout and reads one line from stdin,
// answering true only for "y" or "yes" (case-insensitive). An empty read
// (immediate EOF, e.g. stdin closed) answers false rather than erroring —
// the safe default for a destructive-adjacent confirmation.
func confirmYesNo(stdin io.Reader, stdout io.Writer, prompt string) (bool, error) {
	_, _ = fmt.Fprint(stdout, prompt)

	line, err := bufio.NewReader(stdin).ReadString('\n')
	if err != nil && line == "" {
		if errors.Is(err, io.EOF) {
			return false, nil
		}
		return false, fmt.Errorf("reading confirmation: %w", err)
	}

	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes", nil
}

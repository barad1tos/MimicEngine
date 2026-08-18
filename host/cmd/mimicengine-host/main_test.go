package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// chromeManifestDir returns the directory runInstall writes Chrome's
// native-messaging manifest into on the current OS. It mirrors the
// "chrome" target's Dir from internal/setup's per-OS platformTargets
// (targets_darwin.go / targets_linux.go / targets_windows.go) — this
// package can't call that unexported function directly, and the tests
// below force --browsers=chrome, so they need to know exactly where
// install lands the file regardless of which OS runs them. Ran only on
// darwin locally until CI actually started running `go test` for this
// module on ubuntu-latest, which is when these tests' previously
// hardcoded macOS-only path first got exercised on Linux and failed.
func chromeManifestDir(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
	case "windows":
		appData := os.Getenv("APPDATA")
		if appData == "" {
			appData = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(appData, "MimicEngine", "chromium")
	default: // linux and other POSIX platforms
		return filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts")
	}
}

// withClosedStdin temporarily replaces the real os.Stdin with a pipe whose
// write end is already closed, so anything reading from it (here, the
// serve loop's underlying ops.Serve) hits a clean io.EOF immediately
// instead of blocking on the test process's real stdin. Restored via
// t.Cleanup so later tests in this package see the original os.Stdin.
func withClosedStdin(t *testing.T) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("closing pipe write end: %v", err)
	}
	original := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = original
		_ = r.Close()
	})
}

// TestRun_ChromiumShapedArgvFallsThroughToServe pins the fix for Fix round
// 3's finding C1: Chrome spawns this host with the extension's own origin
// as args[0] ("chrome-extension://<id>/"), never a recognized subcommand
// name. Before the fix, run() treated any non-matching args[0] as an
// "unknown subcommand" error, making serve() unreachable from every real
// Chrome launch.
func TestRun_ChromiumShapedArgvFallsThroughToServe(t *testing.T) {
	withClosedStdin(t)
	err := run([]string{"chrome-extension://" + strings.Repeat("ab", 16) + "/"})
	if err != nil {
		t.Fatalf("run() = %v, want nil — Chromium-shaped argv must fall through to serve, not error as an unknown subcommand", err)
	}
}

// TestRun_FirefoxShapedArgvFallsThroughToServe mirrors the Chromium case
// for Firefox's launch shape: the manifest path followed by the extension
// id, as two separate argv entries.
func TestRun_FirefoxShapedArgvFallsThroughToServe(t *testing.T) {
	withClosedStdin(t)
	err := run([]string{"/path/to/com.barad1tos.mimicengine.json", "palette-mimicry@barad1tos.github.io"})
	if err != nil {
		t.Fatalf("run() = %v, want nil — Firefox-shaped argv must fall through to serve, not error as an unknown subcommand", err)
	}
}

// TestRun_VersionSubcommandIsRecognizedExactly proves "version" is matched
// as an exact subcommand rather than falling through to serve. A closed
// stdin alone can't tell the two outcomes apart — serve() also returns nil
// on immediate EOF — so this captures the real os.Stdout too: runVersion
// writes the version string, while a fall-through to serve would read no
// frames (closed stdin) and write nothing.
func TestRun_VersionSubcommandIsRecognizedExactly(t *testing.T) {
	withClosedStdin(t) // safety net: a misroute to serve must return promptly, not hang

	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	originalStdout := os.Stdout
	os.Stdout = stdoutWrite
	t.Cleanup(func() { os.Stdout = originalStdout })

	runErr := run([]string{"version"})
	if closeErr := stdoutWrite.Close(); closeErr != nil {
		t.Fatalf("closing pipe write end: %v", closeErr)
	}
	if runErr != nil {
		t.Fatalf("run([\"version\"]) = %v, want nil", runErr)
	}

	captured, err := io.ReadAll(stdoutRead)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if got := strings.TrimSpace(string(captured)); got != version {
		t.Fatalf("run([\"version\"]) wrote %q to stdout, want %q (a fall-through to serve would write nothing)", got, version)
	}
}

// TestRun_HelpFlagPrintsUsageWithoutServing pins I1: "-h", "--help", and
// "help" are matched exactly as args[0] and print usage instead of falling
// through to serve — the same closed-stdin trick as
// TestRun_VersionSubcommandIsRecognizedExactly distinguishes the two
// outcomes, since serve() also returns nil on immediate EOF but writes
// nothing to stdout.
func TestRun_HelpFlagPrintsUsageWithoutServing(t *testing.T) {
	for _, helpArg := range []string{"-h", "--help", "help"} {
		t.Run(helpArg, func(t *testing.T) {
			withClosedStdin(t) // safety net: a misroute to serve must return promptly, not hang

			stdoutRead, stdoutWrite, err := os.Pipe()
			if err != nil {
				t.Fatalf("os.Pipe: %v", err)
			}
			originalStdout := os.Stdout
			os.Stdout = stdoutWrite
			t.Cleanup(func() { os.Stdout = originalStdout })

			runErr := run([]string{helpArg})
			if closeErr := stdoutWrite.Close(); closeErr != nil {
				t.Fatalf("closing pipe write end: %v", closeErr)
			}
			if runErr != nil {
				t.Fatalf("run([]string{%q}) = %v, want nil", helpArg, runErr)
			}

			captured, err := io.ReadAll(stdoutRead)
			if err != nil {
				t.Fatalf("ReadAll: %v", err)
			}
			got := string(captured)
			if !strings.Contains(got, "Subcommands:") || !strings.Contains(got, "install") {
				t.Fatalf("run([]string{%q}) stdout = %q, want usage text listing subcommands", helpArg, got)
			}
		})
	}
}

// TestRun_ServeWritesStderrStartupLine pins the second half of I1: entering
// the real serve loop (Chromium-shaped argv falls through to it, same as
// TestRun_ChromiumShapedArgvFallsThroughToServe) logs one line to stderr, so
// a human who lands in serve — a typo'd subcommand, manual testing — sees
// something instead of silence.
func TestRun_ServeWritesStderrStartupLine(t *testing.T) {
	withClosedStdin(t)

	stderrRead, stderrWrite, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	originalStderr := os.Stderr
	os.Stderr = stderrWrite
	t.Cleanup(func() { os.Stderr = originalStderr })

	runErr := run([]string{"chrome-extension://" + strings.Repeat("ab", 16) + "/"})
	if closeErr := stderrWrite.Close(); closeErr != nil {
		t.Fatalf("closing pipe write end: %v", closeErr)
	}
	if runErr != nil {
		t.Fatalf("run() = %v, want nil", runErr)
	}

	captured, err := io.ReadAll(stderrRead)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if !strings.Contains(string(captured), "serving native messaging") {
		t.Fatalf("stderr = %q, want it to mention serving native messaging", captured)
	}
}

func TestRunVersion_WritesVersionString(t *testing.T) {
	var out bytes.Buffer
	if err := runVersion(&out); err != nil {
		t.Fatalf("runVersion: %v", err)
	}
	if got := strings.TrimSpace(out.String()); got != version {
		t.Errorf("runVersion() wrote %q, want %q", got, version)
	}
}

func TestRunInstall_MissingExtensionIDFailsAfterForcedScope(t *testing.T) {
	home := t.TempDir()
	var out bytes.Buffer

	err := runInstall([]string{"--browsers=chrome", "--yes"}, strings.NewReader(""), &out, home)
	if err == nil {
		t.Fatal("runInstall() = nil error, want an error for a Chromium target with no --extension-id")
	}
}

func TestRunInstall_WritesManifestWithForcedScopeAndYes(t *testing.T) {
	home := t.TempDir()
	var out bytes.Buffer

	err := runInstall(
		[]string{"--browsers=chrome", "--yes", "--extension-id=" + strings.Repeat("ab", 16), "--binary=/opt/mimicengine-host"},
		strings.NewReader(""), &out, home,
	)
	if err != nil {
		t.Fatalf("runInstall: %v (output: %s)", err, out.String())
	}

	manifestPath := filepath.Join(chromeManifestDir(home), "com.barad1tos.mimicengine.json")
	if _, statErr := os.Stat(manifestPath); statErr != nil {
		t.Fatalf("expected manifest at %s: %v", manifestPath, statErr)
	}
	if !strings.Contains(out.String(), "installed:") {
		t.Errorf("output = %q, want an \"installed:\" section", out.String())
	}
}

// TestRunInstall_RelativeBinaryIsAbsolutized pins Fix round 3's finding
// I1: Chrome/Firefox require an absolute "path" in the manifest, so a
// relative --binary must be resolved to absolute before it lands there —
// otherwise it would resolve against whatever directory the browser
// happens to spawn the host from, not the directory install was run in.
func TestRunInstall_RelativeBinaryIsAbsolutized(t *testing.T) {
	home := t.TempDir()
	var out bytes.Buffer
	const relativeBinary = "relative/path/mimicengine-host"

	err := runInstall(
		[]string{"--browsers=chrome", "--yes", "--extension-id=" + strings.Repeat("ab", 16), "--binary=" + relativeBinary},
		strings.NewReader(""), &out, home,
	)
	if err != nil {
		t.Fatalf("runInstall: %v (output: %s)", err, out.String())
	}

	manifestPath := filepath.Join(chromeManifestDir(home), "com.barad1tos.mimicengine.json")
	body, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	wantAbs, err := filepath.Abs(relativeBinary)
	if err != nil {
		t.Fatalf("filepath.Abs: %v", err)
	}
	if !strings.Contains(string(body), wantAbs) {
		t.Errorf("manifest = %s, want it to contain the absolutized binary path %q", body, wantAbs)
	}
	if strings.Contains(string(body), `"path":"`+relativeBinary+`"`) {
		t.Errorf("manifest = %s, still contains the relative --binary verbatim", body)
	}
}

func TestRunInstall_DeclineAbortsWithoutWriting(t *testing.T) {
	home := t.TempDir()
	chromeDir := chromeManifestDir(home)
	if err := os.MkdirAll(chromeDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	var out bytes.Buffer

	err := runInstall([]string{"--extension-id=x"}, strings.NewReader("n\n"), &out, home)
	if err != nil {
		t.Fatalf("runInstall: %v", err)
	}
	if !strings.Contains(out.String(), "aborted") {
		t.Errorf("output = %q, want \"aborted\"", out.String())
	}
	if _, statErr := os.Stat(filepath.Join(chromeDir, "com.barad1tos.mimicengine.json")); statErr == nil {
		t.Fatal("manifest was written despite the user declining the confirmation prompt")
	}
}

func TestRunInstall_NoDetectionReportsNothingToDo(t *testing.T) {
	home := t.TempDir() // no browser directories exist, no --browsers override
	var out bytes.Buffer

	if err := runInstall(nil, strings.NewReader(""), &out, home); err != nil {
		t.Fatalf("runInstall: %v", err)
	}
	if !strings.Contains(out.String(), "no browsers detected") {
		t.Errorf("output = %q, want the \"no browsers detected\" message", out.String())
	}
}

func TestRunInstall_BadFlagErrors(t *testing.T) {
	var out bytes.Buffer
	if err := runInstall([]string{"--not-a-real-flag"}, strings.NewReader(""), &out, t.TempDir()); err == nil {
		t.Fatal("runInstall() = nil error, want a flag-parse error")
	}
}

func TestRunUninstall_RemovesWhatInstallWrote(t *testing.T) {
	home := t.TempDir()
	var installOut, uninstallOut bytes.Buffer

	installArgs := []string{"--browsers=chrome", "--yes", "--extension-id=x", "--binary=/opt/mimicengine-host"}
	if err := runInstall(installArgs, strings.NewReader(""), &installOut, home); err != nil {
		t.Fatalf("runInstall: %v", err)
	}

	manifestPath := filepath.Join(chromeManifestDir(home), "com.barad1tos.mimicengine.json")
	if _, err := os.Stat(manifestPath); err != nil {
		t.Fatalf("setup precondition failed, manifest missing: %v", err)
	}

	if err := runUninstall([]string{"--browsers=chrome", "--yes"}, strings.NewReader(""), &uninstallOut, home); err != nil {
		t.Fatalf("runUninstall: %v", err)
	}
	if _, err := os.Stat(manifestPath); !os.IsNotExist(err) {
		t.Fatalf("manifest still present after uninstall: err=%v", err)
	}
	if !strings.Contains(uninstallOut.String(), "removed:") {
		t.Errorf("output = %q, want a \"removed:\" section", uninstallOut.String())
	}
}

func TestRunUninstall_NoDetectionReportsNothingToDo(t *testing.T) {
	home := t.TempDir()
	var out bytes.Buffer

	if err := runUninstall(nil, strings.NewReader(""), &out, home); err != nil {
		t.Fatalf("runUninstall: %v", err)
	}
	if !strings.Contains(out.String(), "nothing to uninstall") {
		t.Errorf("output = %q, want the \"nothing to uninstall\" message", out.String())
	}
}

func TestRunUninstall_DeclineAborts(t *testing.T) {
	home := t.TempDir()
	chromeDir := chromeManifestDir(home)
	if err := os.MkdirAll(chromeDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	manifestPath := filepath.Join(chromeDir, "com.barad1tos.mimicengine.json")
	if err := os.WriteFile(manifestPath, []byte("{}"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	var out bytes.Buffer

	if err := runUninstall(nil, strings.NewReader("n\n"), &out, home); err != nil {
		t.Fatalf("runUninstall: %v", err)
	}
	if _, statErr := os.Stat(manifestPath); statErr != nil {
		t.Fatalf("manifest removed despite declined confirmation: %v", statErr)
	}
}

func TestRunUninstall_BadFlagErrors(t *testing.T) {
	var out bytes.Buffer
	if err := runUninstall([]string{"--not-a-real-flag"}, strings.NewReader(""), &out, t.TempDir()); err == nil {
		t.Fatal("runUninstall() = nil error, want a flag-parse error")
	}
}

func TestRunDoctor_AllNotInstalledExitsClean(t *testing.T) {
	home := t.TempDir()
	var out bytes.Buffer

	if err := runDoctor(nil, &out, home); err != nil {
		t.Fatalf("runDoctor: %v", err)
	}
	if !strings.Contains(out.String(), "not installed") {
		t.Errorf("output = %q, want at least one \"not installed\" line", out.String())
	}
}

func TestRunDoctor_BrokenManifestFailsWithErrDoctorFailed(t *testing.T) {
	home := t.TempDir()
	chromeDir := chromeManifestDir(home)
	if err := os.MkdirAll(chromeDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(chromeDir, "com.barad1tos.mimicengine.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	var out bytes.Buffer

	err := runDoctor(nil, &out, home)
	if !errors.Is(err, errDoctorFailed) {
		t.Fatalf("runDoctor() error = %v, want errDoctorFailed", err)
	}
	if !strings.Contains(out.String(), "chrome") {
		t.Errorf("output = %q, want it to mention chrome", out.String())
	}
}

func TestRunDoctor_BrowsersFlagNarrowsScope(t *testing.T) {
	home := t.TempDir()
	var out bytes.Buffer

	if err := runDoctor([]string{"--browsers=chrome"}, &out, home); err != nil {
		t.Fatalf("runDoctor: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("runDoctor --browsers=chrome printed %d lines, want exactly 1: %v", len(lines), lines)
	}
}

func TestRunDoctor_UnknownBrowserIDErrors(t *testing.T) {
	var out bytes.Buffer
	if err := runDoctor([]string{"--browsers=bogus"}, &out, t.TempDir()); err == nil {
		t.Fatal("runDoctor() = nil error, want an error for an unknown browser id")
	}
}

func TestRunDoctor_BadFlagErrors(t *testing.T) {
	var out bytes.Buffer
	if err := runDoctor([]string{"--not-a-real-flag"}, &out, t.TempDir()); err == nil {
		t.Fatal("runDoctor() = nil error, want a flag-parse error")
	}
}

func TestConfirmYesNo(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{"lowercase y", "y\n", true},
		{"full yes", "yes\n", true},
		{"uppercase Y", "Y\n", true},
		{"mixed-case Yes", "Yes\n", true},
		{"lowercase n", "n\n", false},
		{"empty line", "\n", false},
		{"immediate EOF", "", false},
		{"garbage", "maybe\n", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out bytes.Buffer
			got, err := confirmYesNo(strings.NewReader(tt.input), &out, "proceed? ")
			if err != nil {
				t.Fatalf("confirmYesNo: %v", err)
			}
			if got != tt.want {
				t.Errorf("confirmYesNo(%q) = %v, want %v", tt.input, got, tt.want)
			}
			if !strings.Contains(out.String(), "proceed?") {
				t.Errorf("output = %q, want the prompt echoed", out.String())
			}
		})
	}
}

func TestPrintTargetList_EmptyPrintsNothing(t *testing.T) {
	var out bytes.Buffer
	printTargetList(&out, "installed", nil)
	if out.Len() != 0 {
		t.Errorf("printTargetList with no targets wrote %q, want nothing", out.String())
	}
}

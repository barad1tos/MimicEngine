package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRun_UnknownSubcommandErrors(t *testing.T) {
	err := run([]string{"bogus"})
	if err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Fatalf("run([\"bogus\"]) = %v, want an error naming the unknown subcommand", err)
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
		[]string{"--browsers=chrome", "--yes", "--extension-id=abcdefghijklmnopabcdefghijklmnop", "--binary=/opt/mimicengine-host"},
		strings.NewReader(""), &out, home,
	)
	if err != nil {
		t.Fatalf("runInstall: %v (output: %s)", err, out.String())
	}

	manifestPath := filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "com.barad1tos.mimicengine.json")
	if _, statErr := os.Stat(manifestPath); statErr != nil {
		t.Fatalf("expected manifest at %s: %v", manifestPath, statErr)
	}
	if !strings.Contains(out.String(), "installed:") {
		t.Errorf("output = %q, want an \"installed:\" section", out.String())
	}
}

func TestRunInstall_DeclineAbortsWithoutWriting(t *testing.T) {
	home := t.TempDir()
	chromeDir := filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
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

	manifestPath := filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "com.barad1tos.mimicengine.json")
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
	chromeDir := filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
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
	chromeDir := filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
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

package setup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
)

// CheckStatus classifies one target's doctor result.
type CheckStatus int

const (
	// StatusNotInstalled means no manifest file exists for this target —
	// an expected, non-failing outcome for a browser nobody has installed
	// this host into yet.
	StatusNotInstalled CheckStatus = iota
	// StatusOK means the manifest exists, parses, points at an executable
	// binary, and carries a usable extension/gecko id.
	StatusOK
	// StatusFail means a manifest exists but something about it is broken:
	// it does not parse, its binary is missing or not executable, its
	// extension id is unknown, or (Windows) its registry value is missing
	// or points elsewhere.
	StatusFail
)

// TargetReport is one target's doctor result: a status for exit-code
// purposes, and a single human-readable Detail line explaining it.
type TargetReport struct {
	Target Target
	Status CheckStatus
	Detail string
}

// DoctorReport runs doctorCheck over every target, in table order.
func DoctorReport(targets []Target, reg RegistryWriter) []TargetReport {
	reports := make([]TargetReport, 0, len(targets))
	for _, t := range targets {
		reports = append(reports, doctorCheck(t, reg))
	}
	return reports
}

// doctorCheck runs t's health checks in the order the design spec lists
// them: manifest presence, that it parses, that its binary path exists and
// is executable, and that it carries a usable extension id. A Windows
// target additionally checks that its registry value still points at the
// manifest file doctorCheck just read.
func doctorCheck(t Target, reg RegistryWriter) TargetReport {
	path := manifestPath(t)
	body, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return TargetReport{Target: t, Status: StatusNotInstalled, Detail: "not installed"}
		}
		return TargetReport{Target: t, Status: StatusFail, Detail: fmt.Sprintf("reading manifest: %v", err)}
	}

	binaryPath, extensionRef, err := parseManifest(t.Family, body)
	if err != nil {
		return TargetReport{Target: t, Status: StatusFail, Detail: fmt.Sprintf("manifest does not parse: %v", err)}
	}
	if extensionRef == "" {
		return TargetReport{Target: t, Status: StatusFail, Detail: "extension id: unknown"}
	}
	if err := checkExecutable(binaryPath); err != nil {
		return TargetReport{Target: t, Status: StatusFail, Detail: fmt.Sprintf("binary %q: %v", binaryPath, err)}
	}

	if t.RegistryPath != "" {
		data, present, err := reg.value(t.RegistryPath)
		if err != nil {
			return TargetReport{Target: t, Status: StatusFail, Detail: fmt.Sprintf("reading registry value: %v", err)}
		}
		if !present || data != path {
			return TargetReport{Target: t, Status: StatusFail, Detail: "registry value missing or points elsewhere"}
		}
	}

	return TargetReport{Target: t, Status: StatusOK, Detail: fmt.Sprintf("OK (extension id %s)", extensionRef)}
}

// parseManifest decodes body per family and returns its binary path and
// its extension reference (the Chromium extension id or the Firefox gecko
// id) — empty when the manifest carries no allowed_origins/
// allowed_extensions entry to report, the "unknown" case doctorCheck
// surfaces explicitly rather than treating as a parse failure.
func parseManifest(family Family, body []byte) (binaryPath, extensionRef string, err error) {
	switch family {
	case Chromium:
		var m chromiumManifest
		if err := json.Unmarshal(body, &m); err != nil {
			return "", "", err
		}
		if m.Path == "" {
			return "", "", errors.New("missing \"path\"")
		}
		return m.Path, extractChromiumExtensionID(m.AllowedOrigins), nil
	case Firefox:
		var m firefoxManifest
		if err := json.Unmarshal(body, &m); err != nil {
			return "", "", err
		}
		if m.Path == "" {
			return "", "", errors.New("missing \"path\"")
		}
		if len(m.AllowedExtensions) == 0 {
			return m.Path, "", nil
		}
		return m.Path, m.AllowedExtensions[0], nil
	default:
		return "", "", fmt.Errorf("unknown family %v", family)
	}
}

// extractChromiumExtensionID pulls the extension id out of a Chromium
// manifest's first allowed_origins entry ("chrome-extension://<id>/"),
// returning "" if the entry is absent or does not match that shape.
func extractChromiumExtensionID(origins []string) string {
	if len(origins) == 0 {
		return ""
	}
	const prefix, suffix = "chrome-extension://", "/"
	origin := origins[0]
	if !strings.HasPrefix(origin, prefix) || !strings.HasSuffix(origin, suffix) {
		return ""
	}
	return strings.TrimSuffix(strings.TrimPrefix(origin, prefix), suffix)
}

// checkExecutable reports an error unless path exists, is a regular file,
// and (on every OS but Windows, which has no POSIX execute bit) is
// executable by someone.
func checkExecutable(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("is a directory, not a file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return errors.New("not executable")
	}
	return nil
}

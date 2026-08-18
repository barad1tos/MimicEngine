package setup

import (
	"encoding/json"
	"errors"
	"fmt"
)

// manifestDescription is every manifest's "description" field, optionally
// suffixed for a dev build (see ManifestOptions.Dev).
const manifestDescription = "MimicEngine native messaging host"

// chromiumManifest is the wire shape Chrome/Chromium/Arc/Brave/Edge/
// Vivaldi/Dia read from disk. Field order is fixed by struct declaration
// order, so json.MarshalIndent's output is byte-stable across calls with
// identical inputs.
type chromiumManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

// firefoxManifest is the wire shape Firefox reads from disk.
type firefoxManifest struct {
	Name              string   `json:"name"`
	Description       string   `json:"description"`
	Path              string   `json:"path"`
	Type              string   `json:"type"`
	AllowedExtensions []string `json:"allowed_extensions"`
}

// buildManifest renders the manifest body for family from opts. It fails
// fast on the two inputs a caller must always supply correctly: a non-empty
// BinaryPath (Install resolves a default before calling this), and — for
// the Chromium family only — a non-empty ExtensionID, which has no default
// (see ManifestOptions.ExtensionID).
func buildManifest(family Family, opts ManifestOptions) ([]byte, error) {
	if opts.BinaryPath == "" {
		return nil, errors.New("setup: manifest binary path must not be empty")
	}

	description := manifestDescription
	if opts.Dev {
		description += " (dev)"
	}

	switch family {
	case Chromium:
		if opts.ExtensionID == "" {
			return nil, errors.New("setup: --extension-id is required for a Chromium-family manifest")
		}
		return json.MarshalIndent(chromiumManifest{
			Name:           HostName,
			Description:    description,
			Path:           opts.BinaryPath,
			Type:           "stdio",
			AllowedOrigins: []string{"chrome-extension://" + opts.ExtensionID + "/"},
		}, "", "  ")
	case Firefox:
		geckoID := opts.GeckoID
		if geckoID == "" {
			geckoID = DefaultGeckoID
		}
		return json.MarshalIndent(firefoxManifest{
			Name:              HostName,
			Description:       description,
			Path:              opts.BinaryPath,
			Type:              "stdio",
			AllowedExtensions: []string{geckoID},
		}, "", "  ")
	default:
		return nil, fmt.Errorf("setup: unknown family %v", family)
	}
}

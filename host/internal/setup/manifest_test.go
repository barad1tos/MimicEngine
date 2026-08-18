package setup

import (
	"encoding/json"
	"testing"
)

func TestBuildManifest_Chromium(t *testing.T) {
	body, err := buildManifest(Chromium, ManifestOptions{
		ExtensionID: testExtensionID,
		BinaryPath:  "/usr/local/bin/mimicengine-host",
	})
	if err != nil {
		t.Fatalf("buildManifest: %v", err)
	}

	var m chromiumManifest
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if m.Name != HostName {
		t.Errorf("Name = %q, want %q", m.Name, HostName)
	}
	if m.Path != "/usr/local/bin/mimicengine-host" {
		t.Errorf("Path = %q, want the binary path", m.Path)
	}
	if m.Type != "stdio" {
		t.Errorf("Type = %q, want \"stdio\"", m.Type)
	}
	wantOrigin := "chrome-extension://" + testExtensionID + "/"
	if len(m.AllowedOrigins) != 1 || m.AllowedOrigins[0] != wantOrigin {
		t.Errorf("AllowedOrigins = %v, want [%q]", m.AllowedOrigins, wantOrigin)
	}
}

func TestBuildManifest_ChromiumRequiresExtensionID(t *testing.T) {
	_, err := buildManifest(Chromium, ManifestOptions{BinaryPath: "/bin/host"})
	if err == nil {
		t.Fatal("buildManifest() = nil error, want an error for a missing extension id")
	}
}

func TestBuildManifest_RequiresBinaryPath(t *testing.T) {
	_, err := buildManifest(Chromium, ManifestOptions{ExtensionID: "x"})
	if err == nil {
		t.Fatal("buildManifest() = nil error, want an error for an empty binary path")
	}
}

func TestBuildManifest_Firefox_DefaultGeckoID(t *testing.T) {
	body, err := buildManifest(Firefox, ManifestOptions{BinaryPath: "/usr/local/bin/mimicengine-host"})
	if err != nil {
		t.Fatalf("buildManifest: %v", err)
	}

	var m firefoxManifest
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(m.AllowedExtensions) != 1 || m.AllowedExtensions[0] != DefaultGeckoID {
		t.Errorf("AllowedExtensions = %v, want [%q]", m.AllowedExtensions, DefaultGeckoID)
	}
}

func TestBuildManifest_Firefox_CustomGeckoID(t *testing.T) {
	body, err := buildManifest(Firefox, ManifestOptions{
		BinaryPath: "/usr/local/bin/mimicengine-host",
		GeckoID:    "custom@example.org",
	})
	if err != nil {
		t.Fatalf("buildManifest: %v", err)
	}

	var m firefoxManifest
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(m.AllowedExtensions) != 1 || m.AllowedExtensions[0] != "custom@example.org" {
		t.Errorf("AllowedExtensions = %v, want [\"custom@example.org\"]", m.AllowedExtensions)
	}
}

func TestBuildManifest_DevTagsDescription(t *testing.T) {
	body, err := buildManifest(Firefox, ManifestOptions{BinaryPath: "/bin/host", Dev: true})
	if err != nil {
		t.Fatalf("buildManifest: %v", err)
	}
	var m firefoxManifest
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if m.Description != manifestDescription+" (dev)" {
		t.Errorf("Description = %q, want the dev-tagged description", m.Description)
	}
}

func TestBuildManifest_IsByteStable(t *testing.T) {
	opts := ManifestOptions{ExtensionID: "x", BinaryPath: "/bin/host"}
	first, err := buildManifest(Chromium, opts)
	if err != nil {
		t.Fatalf("buildManifest: %v", err)
	}
	second, err := buildManifest(Chromium, opts)
	if err != nil {
		t.Fatalf("buildManifest: %v", err)
	}
	if string(first) != string(second) {
		t.Fatalf("buildManifest is not byte-stable for identical inputs:\n%s\nvs\n%s", first, second)
	}
}

func TestBuildManifest_UnknownFamily(t *testing.T) {
	_, err := buildManifest(Family(99), ManifestOptions{BinaryPath: "/bin/host"})
	if err == nil {
		t.Fatal("buildManifest() = nil error, want an error for an unknown family")
	}
}

func TestFamily_String(t *testing.T) {
	tests := []struct {
		family Family
		want   string
	}{
		{Chromium, "chromium"},
		{Firefox, "firefox"},
		{Family(99), "unknown"},
	}
	for _, tt := range tests {
		if got := tt.family.String(); got != tt.want {
			t.Errorf("Family(%d).String() = %q, want %q", tt.family, got, tt.want)
		}
	}
}

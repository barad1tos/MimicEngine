#!/usr/bin/env bash
# Codesigns and notarizes the macOS universal binary GoReleaser just built.
# Invoked from `universal_binaries[].hooks.post` in host/.goreleaser.yml as:
#   ./scripts/sign-macos.sh "{{ .Path }}"
#
# Gated on secret presence: every variable in required_vars below is only
# ever set by release.yml's host-release job, sourced from this repo's
# `production` GitHub Actions environment. PR CI never has access to it, and
# as of this writing the production environment does not yet hold Roman's
# Apple Developer ID credentials either — so today this script always hits
# the early-exit below and the release stays green without signing. Once the
# credentials are added to the environment, signing turns on with no
# workflow change.
#
# This path is unexercised: it has never run against real credentials
# (none exist yet). Dry-run it end-to-end the first time the secrets land.
set -euo pipefail

binary_path="${1:?usage: sign-macos.sh <path-to-universal-binary>}"

required_vars=(
  MACOS_CERTIFICATE_P12_BASE64
  MACOS_CERTIFICATE_PASSWORD
  MACOS_SIGN_IDENTITY
  AC_USERNAME
  AC_PASSWORD
  AC_TEAM_ID
)

for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "sign-macos: ${var} not set, skipping codesign+notarize for ${binary_path}" >&2
    exit 0
  fi
done

work_dir="$(mktemp -d)"
keychain="${work_dir}/sign.keychain-db"
keychain_password="$(openssl rand -base64 32)"
cert_path="${work_dir}/cert.p12"
notarize_zip="${work_dir}/notarize.zip"

cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

printf '%s' "$MACOS_CERTIFICATE_P12_BASE64" | base64 --decode >"$cert_path"

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$cert_path" -k "$keychain" -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null

existing_keychains="$(security list-keychains -d user | tr -d '"')"
# shellcheck disable=SC2086 # word-splitting existing_keychains is intentional: each line is one keychain path
security list-keychains -d user -s "$keychain" $existing_keychains

codesign --force --options runtime --timestamp \
  --sign "$MACOS_SIGN_IDENTITY" --keychain "$keychain" "$binary_path"

# Apple's notary service accepts a zip of a bare CLI binary (no .app bundle
# required). Command-line tools cannot be stapled — Gatekeeper verifies the
# notarization ticket online on first run instead, which is the documented
# behavior for this artifact shape.
ditto -c -k --keepParent "$binary_path" "$notarize_zip"

xcrun notarytool submit "$notarize_zip" \
  --apple-id "$AC_USERNAME" \
  --password "$AC_PASSWORD" \
  --team-id "$AC_TEAM_ID" \
  --wait

echo "sign-macos: signed and notarized ${binary_path}" >&2

import { defineConfig } from 'wxt';

// `key` pins the extension to a stable id across reinstalls/rebuilds, which
// native messaging requires: the host's Chromium manifest allow-lists one
// fixed `chrome-extension://<id>/` origin (host/internal/setup/manifest.go),
// and Chrome derives that id from this public key rather than assigning a
// random one per load. The value below is the base64 DER SubjectPublicKeyInfo
// — safe to commit, it has no signing power on its own — for a keypair whose
// PRIVATE half lives OUTSIDE this repo at
// ~/.config/mimicengine/dev-extension-key.pem (chmod 600). Regenerate both
// together if the private key is ever lost or rotated:
//   mkdir -p ~/.config/mimicengine
//   openssl genrsa -out ~/.config/mimicengine/dev-extension-key.pem 2048
//   chmod 600 ~/.config/mimicengine/dev-extension-key.pem
//   openssl rsa -in ~/.config/mimicengine/dev-extension-key.pem -pubout -outform DER | openssl base64 -A
// This keypair resolves to extension id blngbjjcheifbhcdiennaldcmlfkhgfb
// (computed as SHA256(DER public key)[0:16], hex, each nibble mapped a-p —
// Chrome's own id-derivation algorithm), which task 7/8's native host
// install flow passes as --extension-id.
const EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnOLXz0jHWgRAWF79o1nbKv5hEV317GW7ebgG2wR4l/Aki7Xc5ZTkWiaPuvKBHAidmu68uZo4sOZiUOXrCmqCb+/y1ntAuNg/S6kG2J7ps4QG8km4Au17DEjrzI6sZkrzNEIMs7R07nfyy42gU13ZedjAcr5U9JY6XNXJPqOVOaz2ip7DUrUyRr/hXwULss+dgjx2Qnz5oM+Hptg/aNHdYTJNaw3d1Mbld1SZle1mfn6PiO4WRoCxYT4c8zET/IVgiL3G0lCtYowWiSa/NKplnOeKr3jlBZpqHLUUf4KNFHjkdeEbsTBeR4JN5AiPYwLbe3PSoQE2WZInWozQMh+xjwIDAQAB';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Palette Mimicry',
    short_name: 'Palette Mimicry',
    description: 'Remap websites into chosen visual palettes.',
    key: EXTENSION_PUBLIC_KEY,
    permissions: ['storage', 'activeTab', 'scripting'],
    optional_permissions: ['nativeMessaging'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Palette Mimicry',
    },
    browser_specific_settings: {
      gecko: {
        id: 'palette-mimicry@barad1tos.github.io',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  },
});

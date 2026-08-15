import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Palette Mimicry',
    short_name: 'Palette Mimicry',
    description: 'Remap websites into chosen visual palettes.',
    permissions: ['storage', 'activeTab', 'scripting'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Palette Mimicry',
    },
  },
});

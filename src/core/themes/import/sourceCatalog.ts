// Guided-import source catalog: pure static data describing where each supported
// theme source lives on disk, plus deterministic ordering for the picker UI.
// No filesystem access here — paths are display hints, not lookups.

import type { SourceFormatId } from './importTypes';

export type SourcePlatform = 'mac' | 'linux' | 'windows';

export type SourceCard = {
  id: string; // 'jetbrains' | 'vscode' | 'iterm' | 'alacritty' | 'kitty' | 'ghostty' | 'file'
  label: string;
  formats: readonly SourceFormatId[];
  paths: Partial<Record<SourcePlatform, readonly string[]>>;
  instructions?: string; // e.g. iTerm export steps, JetBrains plugin note
  pickerExtensions: readonly string[];
};

const FILE_CARD_ID = 'file';

const FILE_CARD: SourceCard = {
  id: FILE_CARD_ID,
  label: 'File',
  formats: [],
  paths: {},
  pickerExtensions: [],
};

export const SOURCE_CATALOG: readonly SourceCard[] = [
  {
    id: 'jetbrains',
    label: 'JetBrains',
    formats: ['jetbrains-ui', 'jetbrains-editor'],
    paths: {
      mac: ['~/Library/Application Support/JetBrains/<product>/colors/*.icls'],
    },
    instructions:
      "`.theme.json` (richest) lives in the plugin's sources/repo; `.icls` is the fallback",
    pickerExtensions: ['.theme.json', '.json', '.icls', '.xml'],
  },
  {
    id: 'vscode',
    label: 'VS Code',
    formats: ['vscode'],
    paths: {
      mac: ['~/.vscode/extensions/<theme>/themes/*.json'],
      linux: ['~/.vscode/extensions/<theme>/themes/*.json'],
      windows: ['%USERPROFILE%\\.vscode\\extensions\\<theme>\\themes\\*.json'],
    },
    pickerExtensions: ['.json'],
  },
  {
    id: 'iterm',
    label: 'iTerm2',
    formats: ['iterm'],
    paths: {},
    instructions: 'Settings → Profiles → Colors → Color Presets → Export',
    pickerExtensions: ['.itermcolors'],
  },
  {
    id: 'alacritty',
    label: 'Alacritty',
    formats: ['alacritty'],
    paths: {
      mac: ['~/.config/alacritty/alacritty.toml'],
      linux: ['~/.config/alacritty/alacritty.toml'],
    },
    pickerExtensions: ['.toml'],
  },
  {
    id: 'kitty',
    label: 'Kitty',
    formats: ['kitty'],
    paths: {
      mac: ['~/.config/kitty/current-theme.conf', '~/.config/kitty/kitty.conf'],
      linux: ['~/.config/kitty/current-theme.conf', '~/.config/kitty/kitty.conf'],
    },
    pickerExtensions: ['.conf'],
  },
  {
    id: 'ghostty',
    label: 'Ghostty',
    formats: ['ghostty'],
    paths: {
      mac: ['~/Library/Application Support/com.mitchellh.ghostty/config'],
      linux: ['~/.config/ghostty/config'],
    },
    pickerExtensions: [],
  },
  FILE_CARD,
];

/**
 * Maps a raw platform-hint string to the coarse platform buckets the catalog
 * keys its paths by. Case-insensitive so it matches both the legacy
 * `navigator.platform` spelling (`MacIntel`, `Win32`) and the modern
 * `navigator.userAgentData.platform` spelling (`macOS`, `Windows`); a `mac`
 * substring wins over `win`, and anything else (every Linux/BSD variant,
 * `Linux`, ChromeOS, …) falls back to `linux`.
 */
export function detectPlatform(platformHint: string): SourcePlatform {
  const normalized = platformHint.toLowerCase();
  if (normalized.includes('mac')) return 'mac';
  if (normalized.includes('win')) return 'windows';
  return 'linux';
}

function hasPlatformPaths(card: SourceCard, platform: SourcePlatform): boolean {
  const platformPaths = card.paths[platform];
  return platformPaths !== undefined && platformPaths.length > 0;
}

function isPlatformRelevant(card: SourceCard, platform: SourcePlatform): boolean {
  return hasPlatformPaths(card, platform) || card.instructions !== undefined;
}

/**
 * Orders {@link SOURCE_CATALOG} for the guided-import picker: recently used
 * sources first (in `recentSources` order), then sources relevant to
 * `platform` (paths or instructions available for it), then the rest. The
 * catch-all `file` card is always last, even if it appears in
 * `recentSources`. Ordering within the platform-relevant and rest groups
 * follows catalog declaration order. Ids in `recentSources` that don't match
 * any catalog card are ignored.
 */
export function orderSourceCards(
  recentSources: readonly string[],
  platform: SourcePlatform,
): SourceCard[] {
  const recentRank = new Map<string, number>();
  recentSources.forEach((id, index) => {
    if (!recentRank.has(id)) recentRank.set(id, index);
  });

  const recent: SourceCard[] = [];
  const platformRelevant: SourceCard[] = [];
  const rest: SourceCard[] = [];

  for (const card of SOURCE_CATALOG) {
    if (card.id === FILE_CARD_ID) continue;
    if (recentRank.has(card.id)) {
      recent.push(card);
    } else if (isPlatformRelevant(card, platform)) {
      platformRelevant.push(card);
    } else {
      rest.push(card);
    }
  }

  recent.sort((a, b) => {
    const rankA = recentRank.get(a.id) ?? 0;
    const rankB = recentRank.get(b.id) ?? 0;
    return rankA - rankB;
  });

  return [...recent, ...platformRelevant, ...rest, FILE_CARD];
}

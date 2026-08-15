import type { ThemeTokenName } from '../themes';
import type { SemanticRole } from './semanticRoles';

export function mapRoleToToken(role: SemanticRole): ThemeTokenName {
  switch (role) {
    case 'canvas':
      return 'canvas';
    case 'surface':
      return 'surface1';
    case 'text':
      return 'text';
    case 'textMuted':
      return 'textMuted';
    case 'accent':
      return 'accent';
    case 'link':
      return 'link';
    case 'border':
      return 'border';
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'danger':
      return 'danger';
    case 'unknown':
    default:
      return 'text';
  }
}

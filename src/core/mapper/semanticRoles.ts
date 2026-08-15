export type SemanticRole =
  | 'canvas'
  | 'surface'
  | 'text'
  | 'textMuted'
  | 'accent'
  | 'link'
  | 'border'
  | 'success'
  | 'warning'
  | 'danger'
  | 'unknown';

export type RoleClassification = {
  role: SemanticRole;
  confidence: number;
  reasons: string[];
};

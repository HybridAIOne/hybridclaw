export interface TuiSlashMenuPalette {
  reset: string;
  separator: string;
  marker: string;
  markerSelected: string;
  command: string;
  commandSelected: string;
  description: string;
  descriptionSelected: string;
}

export interface TuiSlashMenuEntry {
  id: string;
  label: string;
  insertText: string;
  description: string;
  searchTerms: string[];
  // Lower depth keeps parent commands ahead of nested variants when empty
  // queries or score ties fall back to structural ordering.
  depth: number;
  sortIndex: number;
}

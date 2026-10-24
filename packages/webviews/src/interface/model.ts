// What the block interface table shows; the extension builds it (tables-model.ts). No DOM here, so
// the LAD/FBD view's protocol can use these types on the extension side too.

export interface Row {
  path: string[];
  level: number;
  name: string;
  type: string;
  value: string;
  defaultValue: string;
  retain: boolean | null;
  accessible: boolean;
  visible: boolean;
  writable: boolean;
  setpoint: boolean;
  comment: string;
  start: number;
  end: number;
  structured: boolean;
  declarationEditable: boolean;
  /** The start value can be changed; false where no TIA sample shows how it is written. */
  valueEditable?: boolean;
  problems: string[];
}

export interface InterfaceModel {
  view: 'interface';
  /** Position of the block in its file; files can hold several (external sources). */
  blockIndex?: number;
  blockName: string;
  blockKind: string;
  format: 's7dcl' | 'source' | 'simaticml';
  /** A SimaticML export: shown, never edited (ADR 0014). */
  readOnly?: boolean;
  failsafe: boolean;
  culture: string;
  sections: { kind: string; label: string; rows: Row[]; canAdd: boolean; returnType?: string }[];
  types: string[];
  error?: string;
}

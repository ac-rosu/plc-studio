// Version profiles as data (ADR 0005). The JSON follows schema/profile.schema.json; this module
// expands the compact parameter signatures and offers case-insensitive lookups.
import v21 from '../V21/profile.json' with { type: 'json' };

export type CpuFamily = 'S7-1200' | 'S7-1500';

export interface Verification {
  verified: boolean;
  cases?: string[];
  note?: string;
}

export type TypeClass =
  | 'bool'
  | 'bit'
  | 'int'
  | 'real'
  | 'time'
  | 'date'
  | 'tod'
  | 'dt'
  | 'char'
  | 'string'
  | 'pointer'
  | 'void';

export interface ElementaryType {
  name: string;
  aliases?: string[];
  class: TypeClass;
  bits: number;
  signed?: boolean;
  min?: string;
  max?: string;
  literalPrefixes?: string[];
  cpuFamilies: CpuFamily[];
  verification: Verification;
}

export type Direction = 'in' | 'out' | 'inout';

export interface Parameter {
  name: string;
  direction: Direction;
  /** A data type name, or a generic class: ANY, ANY_NUM, ANY_INT, ANY_REAL, ANY_BIT, ANY_STRING. */
  type: string;
  optional: boolean;
}

export interface SystemType {
  name: string;
  kind: 'fb' | 'struct';
  instruction?: string;
  parameters: Parameter[];
  members: { name: string; type: string }[];
  description?: string;
  cpuFamilies: CpuFamily[];
  verification: Verification;
}

export interface Instruction {
  name: string;
  kind: 'function' | 'fb';
  parameters: Parameter[];
  /** A type name, a generic class, or "=PARAM" (same type as that parameter). */
  returnType?: string;
  variadic?: boolean;
  nonFormal?: boolean;
  instanceTypes?: string[];
  cpuFamilies: CpuFamily[];
  failsafeAllowed: boolean;
  description: string;
  helpUrl?: string;
  verification: Verification;
}

export interface LadderElement {
  name: string;
  languages: ('LAD' | 'FBD')[];
  shape: 'contact' | 'coil' | 'box' | 'jump';
  symbol?: string;
  parameters: Parameter[];
  template?: string;
  /** The box needs an explicit data type: in every block, or only in fail-safe blocks. */
  typeRequired?: 'always' | 'failsafe';
  failsafeAllowed?: boolean;
  /** Corpus cases that prove failsafeAllowed; without them the flag only gives warnings. */
  failsafeVerification?: Verification;
  /**
   * How a SimaticML network names the element (ADR 0014): the part name, and the pin whose
   * negation turns the part into this element (Contact with a negated operand is I_Contact).
   */
  simaticml?: { part: string; negated?: string; cases: string[] };
  description?: string;
  verification: Verification;
}

/** What F-blocks may declare in their interface. */
export interface FailsafeCatalog {
  interfaceTypes: {
    allowed: string[];
    forbidden: string[];
    arrays: 'allowed' | 'forbidden';
    plcDataTypes: 'allowed' | 'forbidden';
    verification: Verification;
  };
}

export interface VersionProfile {
  id: string;
  tiaVersion: string;
  extends: string | null;
  elementaryTypes: ElementaryType[];
  systemTypes: SystemType[];
  instructions: Instruction[];
  ladderElements: LadderElement[];
  /** Instructions whose return value is a status or error code. */
  statusInstructions?: string[];
  /** SimaticML namespaces of block and type exports the corpus proves (ADR 0014). */
  simaticmlSchemas?: SimaticmlSchemas;
  failsafe?: FailsafeCatalog;
  systemConstants: object[];
}

export interface SimaticmlSchemas {
  namespaces: string[];
  verification: Verification;
}

/** "in IN: Bool", "out Q: Bool", "in in1: Bool?" */
export function parseSignature(signature: string): Parameter {
  const m = /^(in|out|inout) ([A-Za-z_][A-Za-z0-9_]*): (.+?)(\?)?$/.exec(signature);
  if (!m) throw new Error(`Bad parameter signature: ${signature}`);
  return { direction: m[1] as Direction, name: m[2]!, type: m[3]!.trim(), optional: m[4] === '?' };
}

interface RawProfile {
  id: string;
  tiaVersion: string;
  extends: string | null;
  elementaryTypes: ElementaryType[];
  systemTypes: (Omit<SystemType, 'parameters' | 'members'> & {
    parameters?: string[];
    members?: string[];
  })[];
  instructions: (Omit<Instruction, 'parameters'> & { parameters: string[] })[];
  ladderElements: (Omit<LadderElement, 'parameters'> & { parameters: string[] })[];
  statusInstructions?: string[];
  simaticmlSchemas?: SimaticmlSchemas;
  failsafe?: FailsafeCatalog;
  systemConstants: object[];
}

export function expandProfile(raw: RawProfile): VersionProfile {
  return {
    ...raw,
    systemTypes: raw.systemTypes.map((t) => ({
      ...t,
      parameters: (t.parameters ?? []).map(parseSignature),
      members: (t.members ?? []).map((m) => {
        const i = m.indexOf(':');
        return { name: m.slice(0, i).trim(), type: m.slice(i + 1).trim() };
      }),
    })),
    instructions: raw.instructions.map((i) => ({
      ...i,
      parameters: i.parameters.map(parseSignature),
    })),
    ladderElements: raw.ladderElements.map((e) => ({
      ...e,
      parameters: e.parameters.map(parseSignature),
    })),
  };
}

export const RAW_PROFILES: Readonly<Record<string, unknown>> = { V21: v21 };

export const PROFILES: Readonly<Record<string, VersionProfile>> = {
  V21: expandProfile(v21 as unknown as RawProfile),
};

/** Case-insensitive lookups into one profile. */
export class ProfileIndex {
  readonly profile: VersionProfile;
  private readonly types = new Map<string, ElementaryType>();
  private readonly system = new Map<string, SystemType>();
  private readonly instructions = new Map<string, Instruction>();
  private readonly ladder = new Map<string, LadderElement>();
  private readonly prefixes = new Map<string, ElementaryType>();

  constructor(profile: VersionProfile) {
    this.profile = profile;
    for (const t of profile.elementaryTypes) {
      this.types.set(t.name.toUpperCase(), t);
      for (const a of t.aliases ?? []) this.types.set(a.toUpperCase(), t);
      for (const p of t.literalPrefixes ?? []) this.prefixes.set(p.toUpperCase(), t);
    }
    for (const t of profile.systemTypes) this.system.set(t.name.toUpperCase(), t);
    for (const i of profile.instructions) this.instructions.set(i.name.toUpperCase(), i);
    for (const e of profile.ladderElements) this.ladder.set(e.name.toUpperCase(), e);
  }

  elementary(name: string): ElementaryType | undefined {
    return this.types.get(name.toUpperCase());
  }

  systemType(name: string): SystemType | undefined {
    return this.system.get(name.toUpperCase());
  }

  instruction(name: string): Instruction | undefined {
    return this.instructions.get(name.toUpperCase());
  }

  ladderElement(name: string): LadderElement | undefined {
    return this.ladder.get(name.toUpperCase());
  }

  /** Type of a typed literal from its prefix (T, LT, INT, WSTRING ...). */
  literalType(prefix: string): ElementaryType | undefined {
    return this.prefixes.get(prefix.toUpperCase());
  }

  /** SOURCE_TO_TARGET conversion functions, e.g. INT_TO_REAL. */
  conversion(name: string): { from: ElementaryType; to: ElementaryType } | undefined {
    const m = /^([A-Z_]+?)_TO_([A-Z_]+)$/i.exec(name);
    if (!m) return undefined;
    const from = this.elementary(m[1]!);
    const to = this.elementary(m[2]!);
    return from && to ? { from, to } : undefined;
  }

  /** The instruction's return value is a status or error code (profile statusInstructions). */
  returnsStatus(name: string): boolean {
    return (this.profile.statusInstructions ?? []).some(
      (n) => n.toUpperCase() === name.toUpperCase(),
    );
  }

  allInstructions(): Instruction[] {
    return this.profile.instructions;
  }
}

const indexes = new Map<string, ProfileIndex>();

export function profileIndex(id: string): ProfileIndex | undefined {
  const profile = PROFILES[id];
  if (!profile) return undefined;
  let index = indexes.get(id);
  if (!index) {
    index = new ProfileIndex(profile);
    indexes.set(id, index);
  }
  return index;
}

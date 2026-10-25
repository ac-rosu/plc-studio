// The names an SCL call can have that are instructions, not blocks: what the editor colors as an
// instruction while a call of a block stays plain text, as TIA does. They come from the version
// profile: its instructions, the instructions of system FBs (TON, CTU …) and conversions between
// elementary types (INT_TO_REAL). Shared by the TextMate grammar generator and the SCL preview in the
// LAD/FBD view, which gets the names with its model.

export interface InstructionNames {
  readonly instructions: readonly string[];
  /** Elementary type names and aliases, for conversions such as DINT_TO_INT. */
  readonly types: readonly string[];
}

interface ProfileLike {
  readonly instructions: readonly { readonly name: string }[];
  readonly systemTypes: readonly { readonly instruction?: string }[];
  readonly elementaryTypes: readonly {
    readonly name: string;
    readonly aliases?: readonly string[];
  }[];
}

export function instructionNames(profile: ProfileLike): InstructionNames {
  return {
    instructions: [
      ...new Set([
        ...profile.instructions.map((i) => i.name),
        ...profile.systemTypes.flatMap((t) => (t.instruction ? [t.instruction] : [])),
      ]),
    ],
    types: profile.elementaryTypes.flatMap((t) => [t.name, ...(t.aliases ?? [])]),
  };
}

/** A case-insensitive test for an instruction name. */
export function isInstruction(names: InstructionNames): (word: string) => boolean {
  const instructions = new Set(names.instructions.map((n) => n.toUpperCase()));
  const types = new Set(names.types.map((n) => n.toUpperCase()));
  return (word) => {
    const upper = word.toUpperCase();
    if (instructions.has(upper)) return true;
    const i = upper.indexOf('_TO_');
    return i > 0 && types.has(upper.slice(0, i)) && types.has(upper.slice(i + 4));
  };
}

// Types of expected.json, as the corpus build writes it (schema/expected.schema.json).

export type CaseKind = 'clean' | 'analyzer' | 'broken';
export type CompileState = 'Success' | 'Warning' | 'Error' | 'importRefused';
export type Exporter = 'documents' | 'source' | 'simaticml' | 'vci_SimaticSD' | 'vci_SimaticML';

export interface ExpectedObject {
  name: string;
  type: 'OB' | 'FB' | 'FC' | 'GlobalDB' | 'ArrayDB' | 'InstanceDB' | 'UDT' | 'TagTable';
  number: number | null;
  language: 'SCL' | 'LAD' | 'FBD' | 'DB' | 'F_LAD' | 'F_FBD' | 'F_DB' | null;
  unit: string | null;
  namespace: string | null;
  group: string | null;
  iecCheck: boolean | null;
  failsafe: boolean;
  consistent: boolean;
}

export interface CompileMessage {
  severity: 'Error' | 'Warning' | 'Success';
  path: string;
  block: string;
  /** TIA's line: counted from BEGIN (external source) or NETWORK (.s7dcl). */
  line: number | null;
  /** 1-based position of the network in a LAD/FBD block. */
  network: number | null;
  description: string;
}

export interface AnalyzerExpectation {
  rule: string;
  block: string;
  line: number | null;
  member?: string;
}

export interface ExpectedCase {
  caseId: string;
  title: string;
  kind: CaseKind;
  basedOn: string | null;
  tiaVersion: string;
  plc: string;
  cpu: string;
  objects: ExpectedObject[];
  exports: {
    documents?: string[];
    source?: string[];
    simaticml?: string[];
    vci?: string[];
    tagtables?: string[];
    refused: Partial<Record<Exporter, Record<string, string>>>;
  };
  compile: {
    state: CompileState;
    errors: number;
    warnings: number;
    messages: CompileMessage[];
    sources: string[];
    importRefusal?: { tool: string; format: string; message: string };
    messagesOfGeneratedVariant?: string;
  };
  intendedError: string | null;
  analyzerExpect: AnalyzerExpectation[];
  notes: string;
}

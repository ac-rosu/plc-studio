// Version profiles as data (ADR 0005). Types follow schema/profile.schema.json.
import v21 from '../V21/profile.json' with { type: 'json' };

export type CpuFamily = 'S7-1200' | 'S7-1500';

export interface Verification {
  verified: boolean;
  cases?: string[];
}

export interface InstructionParameter {
  name: string;
  direction: 'Input' | 'Output' | 'InOut';
  type: string;
  required: boolean;
}

export interface Instruction {
  name: string;
  parameters: InstructionParameter[];
  returnType?: string;
  cpuFamilies: CpuFamily[];
  minFirmware?: Partial<Record<CpuFamily, string>>;
  failsafeAllowed: boolean;
  description: string;
  helpUrl?: string;
  verification: Verification;
}

export interface SystemType {
  name: string;
  cpuFamilies: CpuFamily[];
  members?: object[];
  verification: Verification;
}

export interface VersionProfile {
  id: string;
  tiaVersion: string;
  extends: string | null;
  instructions: Instruction[];
  systemTypes: SystemType[];
  systemConstants: object[];
  typeRules?: object;
  syntaxFeatures?: object;
  sdFormat?: object;
  failsafe?: object;
  cpuFamilies?: object;
}

export const PROFILES: Readonly<Record<string, VersionProfile>> = {
  V21: v21 as VersionProfile,
};

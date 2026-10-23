// OB type, number, cycle time and priority from a SimaticML export of the OB: the .s7dcl does not
// carry them (format-notes, finding 1). The default export has type, number and cycle time;
// the read-only export has the priority. Both may lie next to the .s7dcl.
import type { ObInfo, ObType } from './manifest.ts';
import { attributeText, child, parseXml } from '../formats/xml.ts';

const TYPES: Record<string, ObType> = {
  ProgramCycle: 'ProgramCycle',
  CyclicInterrupt: 'CyclicInterrupt',
  TimeOfDay: 'TimeOfDay',
  TimeDelayInterrupt: 'TimeDelay',
  HardwareInterrupt: 'HardwareInterrupt',
  Startup: 'Startup',
  DiagnosticErrorInterrupt: 'DiagnosticError',
  TimeErrorInterrupt: 'TimeError',
  ProgrammingError: 'ProgrammingError',
  IOAccessError: 'IOAccessError',
};

export function readObAttributes(xml: string): ObInfo | undefined {
  if (!xml.includes('SW.Blocks.OB')) return undefined;
  const root = parseXml(xml);
  const ob = child(root, 'SW.Blocks.OB');
  if (!ob) return undefined;
  const info: ObInfo = {};
  const secondary = attributeText(ob, 'SecondaryType')?.text;
  if (secondary) info.type = TYPES[secondary] ?? 'Other';
  const number = attributeText(ob, 'Number')?.text;
  if (number && /^\d+$/.test(number)) info.number = Number(number);
  const priority = attributeText(ob, 'PriorityNumber')?.text;
  if (priority && /^\d+$/.test(priority)) info.priority = Number(priority);
  const cycle = attributeText(ob, 'CyclicTime')?.text;
  if (cycle && /^\d+$/.test(cycle)) info.cycleTimeMs = Number(cycle) / 1000;
  return info;
}

// PLC Studio core: parsers, project model, type checker, call graph, analyzer, formatter
// and writer. Web-safe: no Node or VS Code imports (ADR 0006).
export {
  POLICY_ERROR_RULES,
  isPolicyErrorRule,
  type PolicyErrorRule,
} from './diagnostics/policy-errors.ts';

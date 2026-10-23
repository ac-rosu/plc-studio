// PLC Studio core: parsers, project model, type checker, call graph, analyzer, formatter
// and writer. Web-safe: no Node or VS Code imports (ADR 0006).
export {
  POLICY_ERROR_RULES,
  isPolicyErrorRule,
  type PolicyErrorRule,
} from './diagnostics/policy-errors.ts';
export * from './text/source-text.ts';
export * from './syntax/ast.ts';
export { lex, T, isTrivia, type Token } from './syntax/lexer.ts';
export { Parser, parseBlockFile, parseBlockText, calleeName } from './syntax/parser.ts';
export * from './formats/s7res.ts';
export * from './formats/tag-table.ts';
export * from './formats/xml.ts';
export * from './formats/document.ts';
export * from './writer/text-edit.ts';
export * from './model/paths.ts';
export * from './model/manifest.ts';
export * from './model/types.ts';
export * from './model/project.ts';
export * from './model/workspace.ts';
export { readObAttributes } from './model/simaticml-ob.ts';
export * from './check/rules.ts';
export * from './check/binder.ts';
export * from './check/analysis.ts';
export * from './services/navigation.ts';
export * from './edit/common.ts';
export * from './edit/declarations.ts';
export * from './edit/resources.ts';
export * from './edit/start-values.ts';
export * from './edit/tag-table.ts';

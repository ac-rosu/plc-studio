# Lossless syntax trees and minimal edits

Parsers produce lossless syntax trees; unchanged files print byte-identical, and every edit (text, table or graphical editor) changes only the affected lines. Unknown constructs are kept as they are. Format-on-save formats only changed lines; whole-file formatting happens only on request. Files go back into TIA, and git diffs and TIA compares must show only real changes, so the usual "parse, then pretty-print" approach is not allowed.

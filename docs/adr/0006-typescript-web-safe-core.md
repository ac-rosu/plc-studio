# TypeScript throughout, with a web-safe core

Parser, checker, analyzer, language server and editors are TypeScript. The core and the language server may not import Node or VS Code APIs, so the same code can run in the desktop language server, a browser worker (vscode.dev) and a future CLI. Designing for the browser from the start is cheap; retrofitting it later is not.

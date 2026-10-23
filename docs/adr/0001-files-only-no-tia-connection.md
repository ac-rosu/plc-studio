# Files only, no connection to TIA Portal

The extension works only on exported files and never talks to TIA Portal, PLCSIM, a PLC or an MCP server. Export and import are done with separate tools (VCI, Openness tools, the owner's MCP server). This keeps the extension cross-platform, offline, free of TIA licensing and version coupling, and safe from damaging projects; the cost is that TIA's own compiler runs only after import, so the extension's checker must catch problems first.

## Considered Options

- Integrate TIA through the owner's MCP server for compile, import and export: rejected; the owner wants the server to stay an independent tool.
- Ship an own Openness bridge: rejected; Windows-only, version-bound (Openness binaries break between versions), and a much larger safety surface.

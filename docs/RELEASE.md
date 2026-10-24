# Releasing PLC Studio

Everything for the first Marketplace release is ready except one decision that is yours: the final name. This page lists what is done, what to decide, and the steps to publish.

## Already done

- Marketplace fields in `packages/extension/package.json`: publisher `acro`, MIT license, repository, bugs and homepage links, a caret range for `engines.vscode`, 15 keywords (at most 30 allowed), version `0.1.0`.
- Icon: the final own-design PNG of 256×256 px (the minimum is 128×128): two power rails, a rung with a contact and a coil, and a rung through a box holding lines of code. It is drawn in `packages/extension/images/icon-source.svg` and rendered with `node scripts/icon.mts` (in `packages/extension`); the SVG is not packaged. No SVG images and no http links in README or CHANGELOG.
- Package: `npm run package` builds `dist/plcstudio-<version>.vsix` and refuses any file outside an allowlist (22 files, about 340 KB; no corpus, tests or source maps).
- README: trademark notice, "not a safety-certified tool", no telemetry and no network calls.
- Release workflow `.github/workflows/release.yml`: on a pushed version tag it runs every test, attaches the `.vsix` to a GitHub release, and, once you enable it, publishes to the Marketplace with Microsoft Entra ID (no stored token). Odd minor versions (`0.1.x`) go out as pre-releases, even ones as releases.

## Your decisions

1. **Final name.** The name is chosen once: a removed Marketplace name can never be used again. It must be unique on the Marketplace and must not contain Siemens trademarks (SIMATIC, STEP 7, TIA Portal, S7 product names). The description may name them only to state compatibility.
   - Keeping "PLC Studio": a Marketplace search on 2026-10-24 found no extension with that display name (the closest were "plca" and "NMR ST Studio"); the Marketplace checks it again when you publish. Nothing else changes.
   - Another name: change `displayName` (and `name` if the extension id should change) in `packages/extension/package.json`, the `PLC Studio` command category and view titles in the same file, the README title, and the activity bar title. Settings (`plcstudio.*`) and language ids can stay as they are.
2. **LICENSE holder.** `LICENSE` names "Andrei Rosu"; confirm or change it.

If you want a different icon: edit `packages/extension/images/icon-source.svg` and run `node scripts/icon.mts` in `packages/extension`, or put any PNG of at least 128×128 px at `images/icon.png` (no Siemens icons or trademarks).

## One-time setup for publishing with Entra ID

1. Create the Marketplace publisher `acro` if it does not exist yet (Visual Studio Marketplace publisher management).
2. In Microsoft Entra ID, register an application for the release workflow and add a federated credential for GitHub Actions: repository `ac-rosu/plc-studio`, entity type "Environment", environment name `marketplace`.
3. Give that application access to the `acro` publisher, following Microsoft's guide for publishing extensions with Entra ID.
4. In the GitHub repository settings:
   - Variables: `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` (from the app registration), `MARKETPLACE_PUBLISH` = `true`.
   - Environment `marketplace` with yourself as required reviewer, so every publish waits for your approval.

Until `MARKETPLACE_PUBLISH` is `true`, a tag only creates the GitHub release with the `.vsix`.

## Publishing a version

1. Update `packages/extension/CHANGELOG.md`; set `version` in `packages/extension/package.json` (odd minor for a pre-release, even minor for a release; a pre-release and a release never share a version).
2. Commit, then tag and push: `git tag v0.1.0 && git push origin v0.1.0`.
3. The workflow tests everything again, creates the GitHub release and, after your approval in the `marketplace` environment, publishes.

The first public version is the pre-release `0.1.0`. After your sign-off on it, `1.0.0` (or `0.2.0`) is the first release. Apply for the verified-publisher badge once the extension has been public for six months and you own a domain that is at least six months old.

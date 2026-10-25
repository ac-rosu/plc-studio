// Messages between the LAD/FBD view and the extension. The view never edits text: it sends
// intents; the extension computes minimal edits with core (ladder/edit.ts) and applies them as a
// WorkspaceEdit, so undo/redo is VS Code's and the text updates live.
import type { ElementRef, LadderBlockView } from '@plcstudio/core';
import type { InterfaceModel } from '../interface/model.ts';

export interface PaletteItem {
  readonly name: string;
  readonly shape: 'contact' | 'coil' | 'box' | 'jump';
  readonly symbol: string;
  readonly description: string;
  readonly languages: readonly ('LAD' | 'FBD')[];
}

export interface ViewDiagnostic {
  readonly start: number;
  readonly end: number;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
}

export interface LadderModel {
  readonly fileName: string;
  readonly view: LadderBlockView | undefined;
  readonly diagnostics: readonly ViewDiagnostic[];
  /** Elements the palette offers; only fail-safe ones in an F-block. */
  readonly palette: readonly PaletteItem[];
  readonly editable: boolean;
  /** Why there is nothing to draw (a DB, a UDT, a parse problem). */
  readonly message: string | undefined;
  /** Open the block interface panel when the view opens (setting plcstudio.ladder.interfaceOpen). */
  readonly interfaceOpen?: boolean;
  /** A SimaticML export: drawn, never edited or checked (ADR 0014). */
  readonly readOnly?: boolean;
}

export type EditIntent =
  | {
      readonly op: 'setOperand';
      readonly start: number;
      readonly end: number;
      readonly expected: string;
      readonly text: string;
    }
  | {
      readonly op: 'connectPin';
      readonly ref: ElementRef;
      readonly pin: string;
      readonly direction: 'in' | 'out';
      readonly text: string;
    }
  /** Insert a palette element before item ref.item (-1: at the end of the rung). */
  | { readonly op: 'insert'; readonly ref: ElementRef; readonly element: string }
  | { readonly op: 'delete'; readonly ref: ElementRef }
  | { readonly op: 'move'; readonly ref: ElementRef; readonly direction: -1 | 1 }
  | { readonly op: 'addBranch'; readonly ref: ElementRef; readonly to?: number }
  | { readonly op: 'deleteBranch'; readonly network: number; readonly rung: number }
  | { readonly op: 'addNetwork'; readonly after: number; readonly language: 'LAD' | 'FBD' }
  | { readonly op: 'deleteNetwork'; readonly network: number }
  | { readonly op: 'moveNetwork'; readonly network: number; readonly direction: -1 | 1 }
  | { readonly op: 'duplicateNetwork'; readonly network: number }
  | { readonly op: 'copyNetwork'; readonly network: number }
  | { readonly op: 'pasteNetwork'; readonly after: number }
  | {
      readonly op: 'setText';
      readonly network: number;
      readonly role: 'title' | 'comment';
      readonly text: string;
    };

/** View → extension. */
export type ViewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'reveal'; readonly start: number; readonly end: number }
  | { readonly type: 'openText' }
  | { readonly type: 'hover'; readonly id: number; readonly offset: number }
  | { readonly type: 'definition'; readonly offset: number }
  | {
      readonly type: 'complete';
      readonly id: number;
      readonly offset: number;
      readonly prefix: string;
    }
  | { readonly type: 'edit'; readonly version: number; readonly intent: EditIntent }
  /** The interface panel was opened, or the block changed while it is open. */
  | { readonly type: 'interfaceRequest' }
  /** An edit from the interface panel, as the block interface editor sends it (op, path ...). */
  | { readonly type: 'interfaceEdit'; readonly [key: string]: unknown };

export interface CompletionEntry {
  readonly label: string;
  readonly detail: string | undefined;
  readonly insertText: string;
}

/** Extension → view. */
export type HostToView =
  | { readonly type: 'update'; readonly model: LadderModel; readonly version: number }
  | { readonly type: 'hoverResult'; readonly id: number; readonly text: string }
  | {
      readonly type: 'completionResult';
      readonly id: number;
      readonly items: readonly CompletionEntry[];
    }
  | {
      readonly type: 'select';
      readonly network: number;
      readonly rung?: number;
      readonly item?: number;
    }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'interfaceUpdate'; readonly model: InterfaceModel }
  /** An interface edit that could not be applied. */
  | { readonly type: 'problem'; readonly message: string };

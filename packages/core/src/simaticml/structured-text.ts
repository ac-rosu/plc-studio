// Rebuilds the SCL text of a network from SimaticML's StructuredText (ADR 0014). The XML keeps
// every token, blank and line break, so the text comes back as TIA stores it; operands come from
// Access elements (locals with #, globals and quoted names as written, constants, calls).
import { child, type XmlElement } from '../formats/xml.ts';

export interface StructuredTextOptions {
  /**
   * The namespace of the block's software unit. TIA's text formats name the unit's own objects
   * without it (FC_FillHelper) and objects outside every unit with `_.` (_.FillFlowRaw), while
   * the XML writes "Filling.FC_FillHelper" and FillFlowRaw (corpus C22).
   */
  readonly namespace?: string | undefined;
}

/** The network's SCL text, lines separated by \n. */
export function structuredText(element: XmlElement, options: StructuredTextOptions = {}): string {
  const out: string[] = [];
  new Writer(out, options.namespace, false).children(element);
  return out.join('');
}

/**
 * An operand of a LAD/FBD network (an Access element of a FlgNet). Global names are quoted as
 * SIMATIC SD writes them, although the network's XML does not mark them (corpus C24).
 */
export function flgNetOperand(access: XmlElement, options: StructuredTextOptions = {}): string {
  const out: string[] = [];
  new Writer(out, options.namespace, true).operand(access);
  return out.join('');
}

const attribute = (e: XmlElement, name: string) => e.attributes.get(name)?.value ?? '';
const count = (e: XmlElement) => Number(attribute(e, 'Num') || '1');
/** Attributes that describe an element, and informative copies (addresses of symbols). */
const skipped = (e: XmlElement) =>
  e.name.endsWith('Attribute') || attribute(e, 'Informative') === 'true';
const hasQuotes = (component: XmlElement) =>
  component.children.some(
    (a) =>
      a.name === 'BooleanAttribute' && attribute(a, 'Name') === 'HasQuotes' && a.text === 'true',
  );
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Writer {
  private readonly out: string[];
  private readonly namespace: string | undefined;
  private readonly quoteGlobals: boolean;

  constructor(out: string[], namespace: string | undefined, quoteGlobals: boolean) {
    this.out = out;
    this.namespace = namespace;
    this.quoteGlobals = quoteGlobals;
  }

  operand(access: XmlElement): void {
    this.access(access);
  }

  children(e: XmlElement): void {
    for (const c of e.children) this.emit(c);
  }

  private emit(e: XmlElement): void {
    if (skipped(e)) return;
    const out = this.out;
    switch (e.name) {
      case 'NewLine':
        out.push('\n'.repeat(count(e)));
        return;
      case 'Blank':
        out.push(' '.repeat(count(e)));
        return;
      case 'Token':
        out.push(attribute(e, 'Text'));
        return;
      case 'Text':
        out.push(e.text);
        return;
      case 'LineComment': {
        // Inserted: a (* … *) comment inside the code; otherwise // to the end of the line
        const text = e.children.filter((c) => c.name === 'Text').map((c) => c.text);
        if (attribute(e, 'Inserted') !== 'true') out.push('//', ...text);
        else out.push('(*', ...text, attribute(e, 'NoClosingBracket') === 'true' ? '' : '*)');
        return;
      }
      case 'Access':
        this.access(e);
        return;
      case 'Parameter':
        out.push(attribute(e, 'Name'));
        this.children(e);
        return;
      default:
        this.children(e);
    }
  }

  private access(e: XmlElement): void {
    const out = this.out;
    switch (attribute(e, 'Scope')) {
      case 'LocalVariable':
        out.push('#');
        this.symbol(child(e, 'Symbol'), false);
        return;
      case 'GlobalVariable':
        this.symbol(child(e, 'Symbol'), true, this.quoteGlobals);
        return;
      case 'Label':
        out.push(attribute(child(e, 'Label')!, 'Name'));
        return;
      case 'LiteralConstant':
      case 'TypedConstant':
        out.push(child(child(e, 'Constant'), 'ConstantValue')?.text ?? '');
        return;
      case 'LocalConstant':
        out.push('#', attribute(child(e, 'Constant')!, 'Name'));
        return;
      case 'GlobalConstant':
        out.push(this.globalName(attribute(child(e, 'Constant')!, 'Name'), true));
        return;
      case 'PredefinedVariable':
        out.push(attribute(child(e, 'PredefinedVariable')!, 'Name'));
        return;
      case 'SystemType':
        out.push(child(e, 'DataType')?.text ?? '');
        return;
      case 'Call':
        for (const c of e.children) {
          if (c.name === 'CallInfo') this.call(c);
          else if (c.name === 'Instruction') {
            out.push(attribute(c, 'Name'));
            this.children(c);
          } else this.emit(c);
        }
        return;
      default:
        this.children(e);
    }
  }

  /** A block call: the instance (#Multi, "IDB") or the FC's name, then the parameter list. */
  private call(info: XmlElement): void {
    const instance = child(info, 'Instance');
    if (instance && attribute(instance, 'Scope') === 'LocalVariable') {
      this.out.push('#');
      this.symbol(instance, false);
    } else if (instance) {
      // the called FC, or a global instance DB: quoted in TIA's text even without HasQuotes
      this.symbol(instance, true, true);
    } else {
      this.out.push(this.globalName(attribute(info, 'Name'), true));
    }
    for (const c of info.children) if (c.name !== 'Instance') this.emit(c);
  }

  /** Components of a name, with their own "." and index tokens. */
  private symbol(e: XmlElement | undefined, global: boolean, quoteFirst = false): void {
    if (!e) return;
    let first = true;
    let afterComponent = false;
    for (const c of e.children) {
      if (skipped(c)) continue;
      if (c.name !== 'Component') {
        this.emit(c);
        afterComponent = false;
        continue;
      }
      // structured text writes the "." between components as a token, a network does not (C24)
      if (afterComponent) this.out.push('.');
      afterComponent = true;
      const name = attribute(c, 'Name');
      this.out.push(
        first && global
          ? this.globalName(name, quoteFirst || hasQuotes(c))
          : hasQuotes(c)
            ? `"${name}"`
            : name,
      );
      for (const part of c.children) if (!skipped(part)) this.emit(part);
      first = false;
    }
  }

  /** A block, DB, tag or constant name as TIA writes it in the code of this block. */
  private globalName(name: string, quoted: boolean): string {
    const ns = this.namespace;
    if (ns && name.startsWith(`${ns}.`)) {
      const own = name.slice(ns.length + 1);
      return PLAIN.test(own) ? own : `"${own}"`;
    }
    if (ns && !quoted && !name.includes('.')) return `_.${name}`;
    return quoted ? `"${name}"` : name;
  }
}

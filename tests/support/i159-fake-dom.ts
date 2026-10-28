// A small DOM for running /admin/receptions.js in node:vm. It parses the server-rendered admin HTML
// (tags, attributes, text; void elements) and offers only the APIs the script uses.
const VOID = new Set(['input', 'br', 'meta', 'link', 'img', 'hr']);
const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export class FakeNode {
  parentNode: FakeElement | null = null;
  ownerDocument: FakeDocument | null = null;
  remove() { this.parentNode?.removeChild(this); }
}
export class FakeText extends FakeNode { data: string; constructor(data: string) { super(); this.data = data; } }
export class FakeElement extends FakeNode {
  childNodes: FakeNode[] = [];
  attributes = new Map<string, string>();
  value = '';
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  tagName: string;
  constructor(tagName: string) { super(); this.tagName = tagName; }
  get children(): FakeElement[] { return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement); }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastElementChild(): FakeElement | null { return this.children.at(-1) ?? null; }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  get id() { return this.getAttribute('id') ?? ''; }
  get classList() {
    const read = () => (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    return { contains: (c: string) => read().includes(c),
      toggle: (c: string, on: boolean) => { const set = new Set(read()); if (on) set.add(c); else set.delete(c); this.setAttribute('class', [...set].join(' ')); return on; } };
  }
  get textContent(): string { return this.childNodes.map(n => n instanceof FakeText ? n.data : (n as FakeElement).textContent).join(''); }
  set textContent(text: string) { for (const n of [...this.childNodes]) this.removeChild(n); if (text) this.appendChild(new FakeText(text)); }
  removeChild(node: FakeNode) {
    const i = this.childNodes.indexOf(node); if (i < 0) throw new Error('not a child');
    this.childNodes.splice(i, 1); node.parentNode = null; this.ownerDocument?.lostNode(node); return node;
  }
  insertBefore(node: FakeNode, ref: FakeNode | null) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length; if (i < 0) throw new Error('bad ref');
    this.childNodes.splice(i, 0, node); node.parentNode = this; return node;
  }
  appendChild(node: FakeNode) { return this.insertBefore(node, null); }
  contains(node: FakeNode | null): boolean { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  closest(selector: string): FakeElement | null { for (let n: FakeElement | null = this; n; n = n.parentNode) if (matches(n, selector)) return n; return null; }
  descendants(): FakeElement[] { return this.children.flatMap(c => [c, ...c.descendants()]); }
  querySelectorAll(selector: string) { return this.descendants().filter(e => matches(e, selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  getElementById(id: string) { return this.descendants().find(e => e.id === id) ?? null; }
  focus() { this.ownerDocument!.activeElement = this; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
}
function matches(e: FakeElement, selector: string): boolean {
  if (selector.includes(',')) return selector.split(',').some(part => matches(e, part.trim()));
  const m = selector.match(/^([a-z]+)?(?:\[([a-z-]+)(?:(\$?=)"([^"]*)")?\])?$/);
  if (!m) throw new Error('unsupported selector ' + selector);
  if (m[1] && e.tagName !== m[1]) return false;
  const value = m[2] ? e.getAttribute(m[2]) : null;
  if (m[2] && (value === null || (m[3] === '=' && value !== m[4]) || (m[3] === '$=' && !value.endsWith(m[4])))) return false;
  return true;
}
export function parse(html: string, doc: FakeDocument): FakeElement {
  const root = new FakeElement('#root'); root.ownerDocument = doc;
  const stack: FakeElement[] = [root];
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>|[^<]+/g)) {
    const [text, tag, attrs] = token;
    if (text.startsWith('<!')) continue;
    if (!tag) { stack.at(-1)!.appendChild(Object.assign(new FakeText(decode(text)), { ownerDocument: doc })); continue; }
    const name = tag.toLowerCase();
    if (text.startsWith('</')) { const i = stack.map(e => e.tagName).lastIndexOf(name); if (i > 0) stack.length = i; continue; }
    const el = new FakeElement(name); el.ownerDocument = doc;
    for (const a of (attrs ?? '').matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], decode(a[2] ?? ''));
    stack.at(-1)!.appendChild(el);
    if (!VOID.has(name) && !text.endsWith('/>')) stack.push(el);
  }
  return root;
}
export class FakeDocument {
  root: FakeElement;
  activeElement: FakeElement | null = null;
  body: FakeElement;
  title = '';
  visibilityState: 'visible' | 'hidden' = 'visible';
  listeners = new Map<string, (() => void)[]>();
  constructor(html: string) {
    this.root = parse(html, this);
    this.body = this.root.querySelector('body') ?? this.root;
    this.title = this.root.querySelector('title')?.textContent ?? '';
    this.activeElement = this.body;
  }
  getElementById(id: string) { return this.root.getElementById(id); }
  adoptNode<T extends FakeNode>(node: T): T {
    node.parentNode?.removeChild(node);
    const walk = (n: FakeNode) => { n.ownerDocument = this; if (n instanceof FakeElement) n.childNodes.forEach(walk); }; walk(node); return node;
  }
  lostNode(node: FakeNode) { if (this.activeElement && node instanceof FakeElement && node.contains(this.activeElement)) this.activeElement = this.body; }
  addEventListener(type: string, fn: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  dispatch(type: string) { for (const fn of this.listeners.get(type) ?? []) fn(); }
}

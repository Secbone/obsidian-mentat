// Minimal mock for Obsidian API classes used in tests

// Polyfill Obsidian DOM extensions on HTMLElement/Element/Node prototypes
function initObsidianDomPolyfills(): void {
  if (typeof HTMLElement === 'undefined') return;

  // Node extensions
  if (!Node.prototype.empty) {
    Node.prototype.empty = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
    };
  }
  if (!Node.prototype.detach) {
    Node.prototype.detach = function () {
      if (this.parentNode) this.parentNode.removeChild(this);
    };
  }

  // Element extensions
  if (!Element.prototype.addClass) {
    Element.prototype.addClass = function (...classes: string[]) {
      this.classList.add(...classes);
    };
  }
  if (!Element.prototype.removeClass) {
    Element.prototype.removeClass = function (...classes: string[]) {
      this.classList.remove(...classes);
    };
  }
  if (!Element.prototype.hasClass) {
    Element.prototype.hasClass = function (cls: string): boolean {
      return this.classList.contains(cls);
    };
  }
  if (!Element.prototype.toggleClass) {
    Element.prototype.toggleClass = function (cls: string | string[], value?: boolean) {
      if (Array.isArray(cls)) {
        cls.forEach(c => typeof value === 'boolean' ? this.classList.toggle(c, value) : this.classList.toggle(c));
      } else {
        typeof value === 'boolean' ? this.classList.toggle(cls, value) : this.classList.toggle(cls);
      }
    };
  }
  if (!Element.prototype.setAttr) {
    Element.prototype.setAttr = function (qualifiedName: string, value: string | number | boolean | null) {
      if (value === null) { this.removeAttribute(qualifiedName); }
      else { this.setAttribute(qualifiedName, String(value)); }
    };
  }
  if (!Element.prototype.getAttr) {
    Element.prototype.getAttr = function (qualifiedName: string): string | null {
      return this.getAttribute(qualifiedName);
    };
  }

  // HTMLElement extensions
  if (!HTMLElement.prototype.setText) {
    HTMLElement.prototype.setText = function (val: string | DocumentFragment) {
      this.empty();
      if (typeof val === 'string') {
        this.textContent = val;
      } else {
        this.appendChild(val);
      }
    };
  }
  if (!HTMLElement.prototype.setCssProps) {
    HTMLElement.prototype.setCssProps = function (props: Record<string, string>) {
      for (const [k, v] of Object.entries(props)) {
        (this.style as Record<string, string>)[k] = v;
      }
    };
  }
  if (!HTMLElement.prototype.show) {
    HTMLElement.prototype.show = function () { this.style.display = ''; };
  }
  if (!HTMLElement.prototype.hide) {
    HTMLElement.prototype.hide = function () { this.style.display = 'none'; };
  }
  if (!HTMLElement.prototype.toggle) {
    HTMLElement.prototype.toggle = function (show: boolean) {
      this.style.display = show ? '' : 'none';
    };
  }
}

// Helper: create element with Obsidian DomElementInfo
function createObsidianElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  o?: DomElementInfo | string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (typeof o === 'string') {
    el.textContent = o;
  } else if (o) {
    if (o.cls) {
      const classes = Array.isArray(o.cls) ? o.cls : o.cls.split(' ');
      el.addClass(...classes);
    }
    if (o.text !== undefined) {
      el.setText(typeof o.text === 'string' ? o.text : o.text.textContent || '');
    }
    if (o.attr) {
      for (const [k, v] of Object.entries(o.attr)) {
        if (v !== null && v !== undefined) el.setAttr(k, v);
      }
    }
    if (o.title) el.title = o.title;
    if (o.placeholder) el.setAttr('placeholder', o.placeholder);
    if (o.href) el.setAttribute('href', o.href);
    if (o.type) el.setAttribute('type', o.type);
    if (o.value) el.setAttribute('value', o.value);
  }
  return el;
}

// Patch global createDiv/createEl/createSpan on Node prototype
function patchNodeCreateMethods(): void {
  if (typeof Node === 'undefined' || (Node.prototype as Record<string, unknown>).createDiv) return;

  (Node.prototype as Record<string, unknown>).createDiv = function (
    o?: DomElementInfo | string,
    callback?: (el: HTMLDivElement) => void,
  ): HTMLDivElement {
    const el = createObsidianElement('div', o);
    this.appendChild(el);
    if (callback) callback(el);
    return el;
  };

  (Node.prototype as Record<string, unknown>).createSpan = function (
    o?: DomElementInfo | string,
    callback?: (el: HTMLSpanElement) => void,
  ): HTMLSpanElement {
    const el = createObsidianElement('span', o);
    this.appendChild(el);
    if (callback) callback(el);
    return el;
  };

  (Node.prototype as Record<string, unknown>).createEl = function <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    o?: DomElementInfo | string,
    callback?: (el: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] {
    const el = createObsidianElement(tag, o);
    this.appendChild(el);
    if (callback) callback(el);
    return el;
  };

  (Node.prototype as Record<string, unknown>).createSvg = function <K extends keyof SVGElementTagNameMap>(
    tag: K,
    o?: SvgElementInfo | string,
    callback?: (el: SVGElementTagNameMap[K]) => void,
  ): SVGElementTagNameMap[K] {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag) as SVGElementTagNameMap[K];
    if (typeof o === 'string') {
      el.textContent = o;
    } else if (o) {
      if (o.cls) {
        const classes = Array.isArray(o.cls) ? o.cls : o.cls.split(' ');
        classes.forEach(c => (el as SVGElement).classList.add(c));
      }
      if (o.attr) {
        for (const [k, v] of Object.entries(o.attr)) {
          if (v !== null && v !== undefined) el.setAttribute(k, String(v));
        }
      }
    }
    this.appendChild(el);
    if (callback) callback(el);
    return el;
  };
}

// Also patch Element.prototype.find/Element.prototype.findAll
function patchElementFind(): void {
  if (typeof Element === 'undefined' || (Element.prototype as Record<string, unknown>).find) return;

  (Element.prototype as Record<string, unknown>).find = function (selector: string): Element | null {
    return this.querySelector(selector);
  };

  (Element.prototype as Record<string, unknown>).findAll = function (selector: string): Element[] {
    return Array.from(this.querySelectorAll(selector));
  };
}

// Re-export global types needed by the mock
export interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}

export interface SvgElementInfo {
  cls?: string | string[];
  attr?: Record<string, string | number | boolean | null>;
  parent?: Node;
  prepend?: boolean;
}

// Initialize polyfills
initObsidianDomPolyfills();
patchNodeCreateMethods();
patchElementFind();

export class Component {
  load(): void {}
  unload(): void {}
  addChild<T extends Component>(child: T): T { return child; }
  registerEvent(_ref: unknown): void {}
  registerDomEvent(_el: unknown, _type: string, _callback: unknown, _options?: unknown): void {}
  registerScopeEvent(_scope: unknown, _type: string, _callback: unknown, _options?: unknown): void {}
}

export class Plugin extends Component {
  manifest = { id: 'test-plugin', name: 'Test', version: '0.0.1', minAppVersion: '1.0.0', author: 'test' };
  loadData = async () => ({});
  saveData = async (_data: Record<string, unknown>): Promise<void> => {};
  addCommand(_cmd: unknown): void {}
  addSettingTab(_tab: unknown): void {}
  addRibbonIcon(_icon: string, _title: string, _cb: () => void): void {}
  registerView(_type: string, _viewCreator: (leaf: unknown) => unknown): void {}
}

export class WorkspaceLeaf {
  app: App;
  constructor(app: App) { this.app = app; }
}

export class View extends Component {
  app: App;
  leaf: WorkspaceLeaf | null = null;

  constructor() {
    super();
    const el = document.createElement('div');
    el.appendChild(document.createElement('div')); // children[0]: nav area
    el.appendChild(document.createElement('div')); // children[1]: content area
    (this as Record<string, unknown>).containerEl = el;
  }

  getIcon(): string { return ''; }
  getDisplayText(): string { return ''; }
  getViewType(): string { return ''; }
}

export class ItemView extends View {
  constructor(leaf: WorkspaceLeaf) {
    super();
    this.app = leaf.app;
    this.leaf = leaf;
  }

  getIcon(): string { return ''; }
  getDisplayText(): string { return ''; }
  getViewType(): string { return ''; }
}

export class Workspace {
  getLeavesOfType = () => [] as unknown[];
  getActiveFile = () => null;
  getRightLeaf = (_split: boolean) => null;
  revealLeaf = (_leaf: unknown): Promise<void> => Promise.resolve();
}

export class Vault {
  getMarkdownFiles = () => [] as never[];
  getAbstractFileByPath = (_path: string) => null;
}

export class MetadataCache {
  getFileCache = () => null;
  getFirstLinkpathDest = () => null;
}

export class App {
  workspace = new Workspace();
  vault = new Vault();
  metadataCache = new MetadataCache();
  setting = { open: () => {}, openTabById: (_id: string) => {} };
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

export function setIcon(_parent: HTMLElement, _iconId: string): void {}

export function getIcon(_iconId: string): SVGSVGElement | null {
  return document.createElementNS('http://www.w3.org/2000/svg', 'svg');
}

export function addIcon(_iconId: string, _svgContent: string): void {}

export function getIconIds(): string[] { return []; }

export function removeIcon(_iconId: string): void {}

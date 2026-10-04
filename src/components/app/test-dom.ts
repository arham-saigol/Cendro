// Minimal React DOM host for the Edge Vitest environment; no browser or network.
class MockNode {}
class MockElement extends MockNode {}
class MockHTMLElement extends MockElement {}
class MockHTMLIFrameElement extends MockHTMLElement {}
class MockHTMLInputElement extends MockHTMLElement {}

(globalThis as any).Node = MockNode;
(globalThis as any).Element = MockElement;
(globalThis as any).HTMLElement = MockHTMLElement;
(globalThis as any).HTMLIFrameElement = MockHTMLIFrameElement;
(globalThis as any).HTMLInputElement = MockHTMLInputElement;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export function createMockElement(tag = "div"): any {
  const el = new MockHTMLElement() as any;
  const children: any[] = [];
  const attributes = new Map<string, string>();
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  el.nodeType = 1;
  el.tagName = tag.toUpperCase();
  el.nodeName = tag.toUpperCase();
  el.children = children;
  el.childNodes = children;
  el.style = {};
  el.dataset = {};
  el.ownerDocument = globalThis.document;
  el.appendChild = (child: any) => {
    child.parentNode = el;
    children.push(child);
    return child;
  };
  el.insertBefore = (child: any, before: any) => {
    child.parentNode = el;
    const index = children.indexOf(before);
    if (index !== -1) children.splice(index, 0, child);
    else children.push(child);
    return child;
  };
  el.removeChild = (child: any) => {
    const index = children.indexOf(child);
    if (index !== -1) children.splice(index, 1);
    child.parentNode = null;
    return child;
  };
  el.setAttribute = (name: string, value: string) => attributes.set(name, value);
  el.getAttribute = (name: string) => attributes.get(name) ?? null;
  el.removeAttribute = (name: string) => attributes.delete(name);
  el.addEventListener = (event: string, fn: (...args: any[]) => void) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event)!.push(fn);
  };
  el.removeEventListener = (event: string, fn: (...args: any[]) => void) => {
    const arr = listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }
  };
  el.dispatchEvent = (event: any) => {
    event.target ??= el;
    for (const listener of listeners.get(event.type) ?? []) listener(event);
    el.parentNode?.dispatchEvent(event);
    return true;
  };
  el.focus = () => { mockDoc.activeElement = el; };
  el.querySelector = () => null;
  el.getBoundingClientRect = () => ({ left: 0, right: 0 });
  return el;
}

const mockDoc: any = new MockNode();
mockDoc.nodeType = 9;
mockDoc.createElement = createMockElement;
// React resolves non-HTML namespaces (svg) through createElementNS.
mockDoc.createElementNS = (_ns: string, tag: string) => createMockElement(tag);
mockDoc.createTextNode = (text: string) => {
  const node: any = new MockNode();
  node.nodeType = 3;
  node.nodeValue = text;
  node.parentNode = null;
  return node;
};
mockDoc.createComment = () => {
  const node: any = new MockNode();
  node.nodeType = 8;
  node.parentNode = null;
  return node;
};
mockDoc.documentElement = createMockElement("html");
mockDoc.head = createMockElement("head");
mockDoc.body = createMockElement("body");
mockDoc.activeElement = null;
mockDoc.addEventListener = () => {};
mockDoc.removeEventListener = () => {};
(globalThis as any).document = mockDoc;
(globalThis as any).window = globalThis;

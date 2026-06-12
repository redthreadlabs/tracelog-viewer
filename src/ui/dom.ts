/**
 * Minimal DOM construction helper — no framework, just typed
 * document.createElement with props and children.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: {
    className?: string;
    text?: string;
    html?: string;
    title?: string;
    attrs?: Record<string, string>;
    on?: Partial<{ [E in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[E]) => void }>;
  },
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    if (props.className) node.className = props.className;
    if (props.text !== undefined) node.textContent = props.text;
    if (props.html !== undefined) node.innerHTML = props.html;
    if (props.title) node.title = props.title;
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
    }
    if (props.on) {
      for (const [event, handler] of Object.entries(props.on)) {
        node.addEventListener(event, handler as EventListener);
      }
    }
  }
  if (children) {
    for (const child of children) {
      node.append(child);
    }
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

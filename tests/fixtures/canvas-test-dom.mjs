// The renderer tests need DOM identity, focus, and tree traversal, not layout.
export function createCanvasTestDom(html) {
    let document;
    class Element {
        constructor(tagName = "div") {
            this.tagName = tagName;
            this.attributes = new Map();
            this.children = [];
            this.listeners = new Map();
            this.dataset = {};
            this.style = {};
            this.className = "";
            this.value = "";
            this.hidden = false;
            this.disabled = false;
            this.open = false;
            this.ownText = "";
            this.classList = {
                add: (...names) => { this.className = [...new Set([...this.className.split(" "), ...names])].join(" "); },
                remove: (...names) => { this.className = this.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
                toggle: (name, force = !this.className.split(" ").includes(name)) => {
                    if (force) this.classList.add(name);
                    else this.classList.remove(name);
                },
            };
        }
        set textContent(value) { this.ownText = String(value); this.replaceChildren(); }
        get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
        get options() { return this.querySelectorAll("option"); }
        get isConnected() { return document.body.contains(this); }
        setAttribute(name, value) {
            this.attributes.set(name, String(value));
            if (name === "id") this.id = String(value);
            if (name === "tabindex") this.tabIndex = Number(value);
            if (name.startsWith("data-")) {
                this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
            }
        }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        append(...children) {
            for (const child of children) {
                if (child.parentElement) child.remove();
                child.parentElement = this;
                this.children.push(child);
            }
        }
        replaceChildren(...children) {
            for (const child of this.children) child.parentElement = null;
            this.children = [];
            this.append(...children);
        }
        remove() {
            if (this.parentElement) {
                this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
                this.parentElement = null;
            }
        }
        contains(target) {
            for (let current = target; current; current = current.parentElement) {
                if (current === this) return true;
            }
            return false;
        }
        matches(selector) {
            const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
            if (tag && this.tagName !== tag) return false;
            for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) {
                if (!this.className.split(" ").includes(name)) return false;
            }
            for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g)) {
                if (!this.attributes.has(name) || (value !== undefined && this.getAttribute(name) !== value)) return false;
            }
            return true;
        }
        closest(selector) {
            for (let current = this; current; current = current.parentElement) {
                if (current.matches(selector)) return current;
            }
            return null;
        }
        querySelectorAll(selector) {
            if (selector.startsWith(":scope > ")) return this.children.filter((child) => child.matches(selector.slice(9)));
            return this.children.flatMap((child) => [
                ...(child.matches(selector) ? [child] : []),
                ...child.querySelectorAll(selector),
            ]);
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
        addEventListener(type, listener) {
            const previous = this.listeners.get(type);
            this.listeners.set(type, previous
                ? (event) => { previous(event); listener(event); }
                : listener);
        }
        focus() { document.activeElement = this; this.listeners.get("focus")?.({ target: this }); }
        scrollIntoView() {}
        setCustomValidity(message) { this.validationMessage = message; }
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
        showModal() { this.open = true; }
        close() { this.open = false; }
    }
    class Input extends Element {}
    class Textarea extends Element {}
    const listeners = new Map();
    const createElement = (tag) => tag === "input" ? new Input(tag) : tag === "textarea" ? new Textarea(tag) : new Element(tag);
    document = {
        body: new Element("body"),
        activeElement: null,
        createElement,
        createElementNS: (_, tag) => createElement(tag),
        getElementById: (id) => document.body.querySelectorAll("[id]").find((node) => node.id === id) ?? null,
        querySelectorAll: (selector) => document.body.querySelectorAll(selector),
        addEventListener: (type, listener) => listeners.set(type, listener),
    };
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
    if (body === undefined) throw new Error("Canvas markup must contain a body");
    const stack = [document.body];
    const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    for (const [, closing, tag, attrs] of body.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([\w-]+)\b([^>]*)>/g)) {
        if (closing) {
            if (stack.length === 1 || stack.pop().tagName !== tag) {
                throw new Error(`Unbalanced canvas closing tag: ${tag}`);
            }
            continue;
        }
        const element = createElement(tag);
        for (const [, name, doubleQuoted, singleQuoted, unquoted] of attrs.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)) {
            const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
            element.setAttribute(name, value);
            if (name === "class") element.className = value;
            if (["hidden", "disabled", "open"].includes(name)) element[name] = true;
        }
        stack[stack.length - 1].append(element);
        if (!voidTags.has(tag) && !attrs.trimEnd().endsWith("/")) stack.push(element);
    }
    if (stack.length !== 1) throw new Error("Unclosed canvas markup");
    return { document, listeners, HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea };
}

# uentropy

> This project is heavily inspired by the amazing work of **Alan** ([@18alantom](https://github.com/18alantom)) and his 🍓: https://github.com/18alantom/strawberry


A small reactive DOM library. 
* No virtual DOM, no compiler
* No JSX. 
* You write plain HTML with a few extra attributes and plain JavaScript.


The core idea is simple: wrap your data in `en.init()`, put `en-mark` on the elements that should display it, and that's most of what you need to know.

```html
<span en-mark="count">0</span>
<button onclick="data.count++">+</button>

<script src="https://unpkg.com/uentropy/dist/entropy.min.js"></script>
<script>
  window.data = UEntropy.default.init();
  data.count = 0;
</script>
```

## Installation

```bash
npm install uentropy
```

Drop the IIFE build into your HTML. No bundler, no build step:

```html
<script src="https://cdn.jsdelivr.net/npm/uentropy/dist/entropy.min.js"></script>
<script>
  const en = UEntropy.default;
  window.data = en.init();
</script>
```

ESM import for bundled projects:

```js
import en from 'uentropy';
const data = en.init();
```


## How it works

`en.init()` returns a `Proxy` wrapping an empty object. Setting any property on it triggers a DOM scan for elements whose directive attribute matches that key, then updates them. No diffing, no scheduling, just a `set` trap and `querySelectorAll`.

**Important:** `en.init()` starts with an empty object. You must assign all keys explicitly after calling it. The order matters so assign parent objects before accessing nested keys.

```js
const data = en.init();

// correct: assign the parent first
data.user = { name: 'Alice', age: 30 };

// also correct: assign keys individually
data.user = {};
data.user.name = 'Alice';
data.user.age  = 30;
```

**`window.data` vs `const data`** :  examples use `window.data` so that inline `onclick="data.count++"` attributes can access the reactive object from the global scope. If you use `addEventListener` instead of inline handlers, a local `const data` works fine and is cleaner.

```js
// needs window.data because onclick runs in global scope
<button onclick="data.count++">+</button>

// local variable is fine when wiring events in JS
const data = en.init();
document.getElementById('btn').addEventListener('click', () => data.count++);
```

**Initialization order** always follow this sequence:

```js
en.prefix('x');       // 1. optional: must be before init()
en.directive(...);    // 2. optional: must be before init()
const data = en.init(); // 3. starts reactivity, scans DOM for templates
data.count = 0;       // 4. assign reactive keys after init()
```


## Directives

Directives are HTML attributes that tell uentropy what to do with a value.

### `en-mark`

Sets `textContent` to the value. For objects, serialises to JSON.

```html
<span en-mark="user.name"></span>
<pre  en-mark="config"></pre>
```

Objects are serialised automatically:

```js
data.config = { theme: 'dark', lang: 'en' };
// → pre gets: {"theme":"dark","lang":"en"}
```

Do not combine `en-mark` and `en-model` on the same element, use separate elements for display and input.

```html
<!-- wrong — conflicting directives on one element -->
<input en-mark="name" en-model="name" />

<!-- correct — separate elements -->
<input en-model="name" />
<span  en-mark="name"></span>
```

### `en-model`

Two-way binding. Keeps a reactive key and an input in sync: no `oninput` handler needed.

```html
<!-- text -->
<input en-model="name" />

<!-- number — writes a JS number, not a string -->
<input type="number" en-model="qty" />

<!-- checkbox — writes true/false -->
<input type="checkbox" en-model="agreed" />

<!-- radio group — writes the value attribute of the selected radio -->
<input type="radio" en-model="size" value="S" name="size" /> S
<input type="radio" en-model="size" value="M" name="size" /> M
<input type="radio" en-model="size" value="L" name="size" /> L

<!-- select -->
<select en-model="country">
  <option value="pl">Poland</option>
  <option value="de">Germany</option>
</select>

<!-- textarea -->
<textarea en-model="bio"></textarea>
```

| Element | Event listened | Data type written |
|---|---|---|
| `input` (text, email, password, …) | `input` | string |
| `input[type=number]` | `input` | number |
| `input[type=checkbox]` | `change` | boolean |
| `input[type=radio]` | `change` | string (`value` attribute) |
| `select` | `change` | string |
| `textarea` | `input` | string |

Listeners are attached once per element and garbage-collected with the element — no manual cleanup needed.

**`en-model` and `en.computed()` on the same key will conflict.** The computed will overwrite whatever the user typed on every dependency change. Use computed for derived read-only values and `en-model` for user-editable values — never both on the same key.

### `en-if` / `en-ifnot`

Must be on a `<template>` element. uentropy moves the template content into the DOM when the condition is met, and puts it back when it is not.

```html
<template en-if="isLoggedIn">
  <nav>…</nav>
</template>

<template en-ifnot="isLoggedIn">
  <a href="/login">Sign in</a>
</template>
```

### Lists

Use `#` as a wildcard key to mark the item template:

```html
<ul>
  <li en-mark="items.#"></li>
</ul>
```

```js
data.items = ['one', 'two', 'three'];
data.items.push('four');       // appends one item
data.items.splice(1, 1);       // removes one item
data.items[0] = 'updated';     // updates one item in place
data.items = ['a', 'b'];       // replaces all — destroys and recreates DOM nodes
```

Object arrays — nest keys inside the placeholder using the same `#`:

```html
<ul>
  <li en-mark="users.#">
    <strong en-mark="users.#.name"></strong>
    <span   en-mark="users.#.email"></span>
  </li>
</ul>
```

```js
data.users = [
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob',   email: 'bob@example.com'   },
];
```

### Deleting keys

Use the native `delete` operator. uentropy detects it and removes the corresponding element from the DOM.

```js
data.message = 'Hello';
delete data.message; // removes the element bound to "message"
```

### Custom directives

Register your own with `en.directive(name, callback, isParametric?)`. Must be called before `en.init()`.

```js
// simple directive: en-color="key"
en.directive('color', ({ el, value }) => {
  el.style.color = String(value);
});

// parametric directive — en-attr="key:attribute-name"
en.directive('attr', ({ el, value, param }) => {
  if (param) el.setAttribute(param, String(value));
}, true);
```

```html
<p en-color="theme.primary">Hello</p>
<status-pill en-attr="card.status:status"></status-pill>
```

The callback receives:
- `el` — the DOM element
- `value` — current reactive value
- `param` — the part after the colon (parametric directives only)
- `key` — full dotted key string (e.g. `"user.name"`)
- `isDelete` — `true` when the property was deleted


## API

### `en.init()`

Returns the reactive data proxy. Idempotent: multiple calls return the same proxy. Call once, then assign keys on the returned object.

```js
const data = en.init();
data.count = 0;
data.user  = { name: 'Alice' };
```

### `en.computed(fn)`

Wraps a function so it re-runs automatically when its reactive dependencies change. Assign the result to a key — uentropy calls the function immediately to seed the value and record which keys it reads.

```js
data.first    = 'Jane';
data.last     = 'Doe';
data.fullName = en.computed(() => `${data.first} ${data.last}`);
```

Async computed — just return a Promise. Stale results from rapid successive changes are automatically discarded.

```js
data.postId  = 1;
data.loading = false;

data.post = en.computed(async () => {
  data.loading = true;
  try {
    const res = await fetch(`/api/posts/${data.postId}`);
    return await res.json();
  } finally {
    data.loading = false;
  }
});
```

```html
<template en-if="loading"><p>Loading…</p></template>
<template en-ifnot="loading">
  <h1 en-mark="post.title"></h1>
</template>
```

**Dependency tracking** is key-based and reevaluated on every execution. If a computed conditionally reads different keys (`data.flag ? data.a : data.b`), the dep graph updates correctly on each run — only the keys actually read during the last execution are tracked.

### `en.watch(key, fn)`

Calls `fn(newValue)` whenever the value at `key` or any of its children changes.

```js
en.watch('cart', () => recalculateTotal());
en.watch('user.name', name => console.log('Name changed to', name));
```

### `en.unwatch(key?, fn?)`

Removes watchers. All four combinations work:

```js
en.unwatch();                     // remove all watchers
en.unwatch('cart');               // remove all watchers for this key
en.unwatch(undefined, handler);   // remove this handler from all keys
en.unwatch('cart', handler);      // remove this handler from this key
```

### `en.batch(fn)`

Queues all reactive writes inside `fn` and flushes the DOM exactly once when it returns. Use whenever you change multiple keys at once.

```js
en.batch(() => {
  data.loading = false;
  data.results = response.items;
  data.total   = response.total;
});
```

Without `batch`, each assignment triggers a separate DOM pass. With `batch`, all three happen in one pass.

### `en.prefix(value?)`

Changes the directive prefix from `en-` to something else. Must be called before `en.init()`.

```js
en.prefix('data-x');
// now use data-x-mark, data-x-if, data-x-model, etc.
```

### `en.directive(name, callback, isParametric?)`

Registers a custom directive. No-op if the name is already registered. Must be called before `en.init()`.

### `en.register(...)`

Registers `<template name="…">` elements as Web Components backed by Shadow DOM. Accepts no arguments (scans the document), an element, a string, or a tagged-template literal.

```js
en.register`
  <template name="user-card">
    <style>:host { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; }</style>
    <slot name="name"></slot>
    <slot name="role"></slot>
  </template>
`;
```

```html
<user-card>
  <span slot="name" en-mark="user.name"></span>
  <span slot="role" en-mark="user.role"></span>
</user-card>
```

### `en.load(files)`

Fetches external HTML files and registers any `<template name="…">` elements found inside.

```js
await en.load(['components/card.html', 'components/modal.html']);
```

### `en.destroy()`

Removes all event listeners, clears watchers, stops all updates. Call when tearing down a widget or navigating away in a SPA.

```js
en.destroy();
```


## Multiple instances

The default export is a singleton — one reactive scope for the whole page. For isolated widgets or micro-frontends use `createInstance()`:

```js
import { createInstance } from 'uentropy';
// or: const { createInstance } = UEntropy;

const enA = createInstance();
const enB = createInstance();

enA.prefix('widget-a');
enB.prefix('widget-b');

const dataA = enA.init();
const dataB = enB.init();

// completely isolated — changing dataA never affects dataB
dataA.count = 0;
dataB.count = 0;

// teardown one without affecting the other
enA.destroy();
```


## Limits

These are deliberate trade-offs, not bugs.

**Scale.** `querySelectorAll` runs on every reactive write. Results are cached between writes and invalidated by a `MutationObserver` when the DOM changes. For small-to-medium DOMs this is faster than virtual DOM diffing. Beyond ~2000–3000 active reactive elements the cost starts to compound, especially on replace-all operations. Use `en.batch()` for bulk writes.

**No key-based reconciliation.** When you reassign an array (`data.rows = newRows`), uentropy removes all existing item elements and recreates them from the template. Frameworks like Preact and Vue reuse DOM nodes by key, uentropy does not. For lists that update frequently and partially, mutate in place rather than replacing the whole array.

```js
// expensive — destroys and recreates all DOM nodes
data.items = data.items.filter(x => x.active);

// cheaper — removes one node
const idx = data.items.findIndex(x => x.id === id);
data.items.splice(idx, 1);
```

**Reactive arrays are shallow.** `push`, `splice`, and index assignment are tracked. Methods that return a new array (`map`, `filter`, `reduce`) are not. Assign the result back to trigger an update.

```js
data.items.filter(x => x.done);          // does nothing to the DOM
data.items = data.items.filter(x => x.done); // updates the DOM
```

**No SSR.** uentropy reads and writes the live DOM. There is no string rendering path.

**Computed dependency tracking is key-based.** A computed re-runs when any key it read during its last execution is set, regardless of whether the value actually changed. Avoid expensive work inside computeds that depend on frequently-changing keys.

**`en-mark` on objects serialises to JSON.** There is no template syntax inside a mark value. Use custom directives or nested elements for structured output.

**`en-model` listens to one event per element.** `input` for text-like inputs, `change` for checkboxes, radios, and selects. For custom elements that fire different events, register a custom directive.

**`en-model` and `en.computed()` conflict on the same key.** The computed will overwrite user input on every dependency change. Use them on separate keys.

**Custom directives registered after `en.init()` are ignored** for elements already in the DOM. Register all directives before calling `en.init()`.

**Web Components require Shadow DOM.** Named `<template>` registration uses `attachShadow`. Works in all modern browsers, no fallback for older environments.


## License

MIT

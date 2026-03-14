/**
 * core.ts – Reactive engine
 *
 * Contains the tightly-coupled pieces that cannot be cleanly separated
 * without introducing circular imports:
 *
 *  • reactive()         – wraps a value in a Proxy
 *  • Proxy handler      – traps get / set / deleteProperty / defineProperty
 *  • update()           – propagates a change to watchers + directives
 *  • callDirectives()   – split into focused helpers (array / object / primitive)
 *  • DOM array helpers  – updateArrayItemElement, sortArrayItemElements, …
 *  • syncNode / Conditional (if/ifnot) handlers
 */

import { enPrefix } from './symbols';
import { getKey, getParam, isPrefixedObject, clone } from './utils';
import type { EntropyContext } from './context';
import type { Prefixed, SyncConfig, DirectiveEntry } from './types';
import {
  setDependents,
  getDependentsOf,
  removeDependentsFor,
  bumpVersion,
  isCurrentVersion,
  clearDepsForKey,
  registerTrackedDeps,
} from './computed';
import { callWatchers } from './watchers';
import { getValue } from './dom/queries';
import { registerBuiltins } from './directives/index';
import { createConditionalDirectives } from './directives/builtins';

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Seeds built-in directives on the context.
 * Must be called once after `createContext()` and before `init()`.
 */
export function bootstrapDirectives(ctx: EntropyContext): void {
  registerBuiltins(ctx);

  const conditionals = createConditionalDirectives(
    (el, value, key, type) => ifOrIfNot(ctx, el, value, key, type),
  );
  ctx.directives.set('if', conditionals.if);
  ctx.directives.set('ifnot', conditionals.ifnot);
}

// ─── Element cache ────────────────────────────────────────────────────────────

/**
 * Attaches a MutationObserver that clears ctx.elementCache whenever the DOM
 * changes. Without this, cached querySelectorAll results would become stale
 * after nodes are inserted or removed (e.g. en-if, array updates).
 *
 * Safe to call multiple times – a second call is a no-op.
 */
export function setupObserver(ctx: EntropyContext): void {
  if (ctx.observer || typeof MutationObserver === 'undefined') return;
  ctx.observer = new MutationObserver(() => ctx.elementCache.clear());
  ctx.observer.observe(document, { childList: true, subtree: true });
}

/**
 * Runs querySelectorAll with a per-context result cache.
 * Results are only cached when the search root is the whole document —
 * scoped searches (e.g. inside a single array item) are never cached because
 * their root element may itself be transient.
 */
function queryAll(
  ctx: EntropyContext,
  root: Document | Element,
  query: string,
): Element[] {
  if (!(root instanceof Document)) {
    return Array.from(root.querySelectorAll(query));
  }
  const cached = ctx.elementCache.get(query);
  if (cached) return cached;
  const result = Array.from(root.querySelectorAll(query));
  ctx.elementCache.set(query, result);
  return result;
}

// ─── reactive() ───────────────────────────────────────────────────────────────

/**
 * Makes a value reactive by wrapping objects/arrays in a Proxy and attaching
 * the `enPrefix` key-path marker. Functions become computed values and have
 * their dependencies tracked.
 */
export function reactive<T>(
  ctx: EntropyContext,
  obj: T,
  prefix: string,
  parent?: Prefixed<object>,
  prop?: string,
): T | Prefixed<T> {
  if (obj === null) return obj;

  const isObject = typeof obj === 'object';
  const isFunction = typeof obj === 'function';

  if (isFunction && parent) {
    obj = (obj as unknown as Function).bind(parent) as unknown as T;
  }

  if (isObject || isFunction) {
    Object.defineProperty(obj, enPrefix, {
      value: prefix,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }

  // Functions are computed values – track their deps and return early
  // (functions are NOT further wrapped in a Proxy)
  if (isFunction && prop && parent) {
    setDependents(ctx, obj as unknown as Prefixed<Function>, prefix, parent, prop);
    return obj;
  }

  if (!isObject) return obj;

  type K = keyof T;
  const proxied = new Proxy(
    obj as unknown as Prefixed<object>,
    makeHandler(ctx),
  ) as Prefixed<T>;

  for (const p of Object.keys(obj as object)) {
    const childPrefix = getKey(p, prefix);
    const value = (obj as Record<string, unknown>)[p];
    (obj as Record<string, unknown>)[p] = reactive(
      ctx,
      value,
      childPrefix,
      proxied,
      p,
    );
  }

  return proxied;
}

// ─── Proxy handler factory ────────────────────────────────────────────────────

function makeHandler(ctx: EntropyContext): ProxyHandler<Prefixed<object>> {
  return {
    // ── get ───────────────────────────────────────────────────────────────────
    get(
      target: Prefixed<object>,
      prop: string | symbol,
      receiver: Prefixed<object>,
    ): unknown {
      // Track dependencies during computed evaluation
      if (
        ctx.deps.isEvaluating &&
        typeof prop === 'string' &&
        Object.getOwnPropertyDescriptor(target, prop)?.enumerable
      ) {
        ctx.deps.set.add(getKey(prop, target[enPrefix]));
      }

      const value = Reflect.get(target, prop, receiver);

      // Call computed functions, but not if they are a computed *result*
      if (
        typeof value === 'function' &&
        enPrefix in value &&
        !ctx.computedResultFns.has(value)
      ) {
        const result = value();
        if (result instanceof Promise) {
          return result.then(v => proxyComputed(ctx, v));
        }
        return proxyComputed(ctx, result);
      }

      return value;
    },

    // ── set ───────────────────────────────────────────────────────────────────
    set(
      target: Prefixed<object>,
      prop: string | symbol,
      value: unknown,
      receiver: Prefixed<object>,
    ): boolean {
      if (typeof prop === 'symbol') {
        return Reflect.set(target, prop, value, receiver);
      }

      const key = getKey(prop, target[enPrefix]);
      const reactiveValue = reactive(ctx, value, key, receiver, prop);
      const success = Reflect.set(target, prop, reactiveValue, receiver);

      scheduleUpdate(ctx, () =>
        update(ctx, reactiveValue, key, false, receiver, prop),
      );
      scheduleUpdate(ctx, () => updateComputed(ctx, key));

      return success;
    },

    // ── deleteProperty ────────────────────────────────────────────────────────
    deleteProperty(target: Prefixed<object>, prop: string | symbol): boolean {
      if (typeof prop === 'symbol') {
        return Reflect.deleteProperty(target, prop);
      }

      const key = getKey(prop, target[enPrefix]);
      const success = Reflect.deleteProperty(target, prop);

      update(ctx, undefined, key, true, target, prop);
      removeDependentsFor(ctx, key);

      return success;
    },

    // ── defineProperty ────────────────────────────────────────────────────────
    defineProperty(
      target: Prefixed<object>,
      prop: string | symbol,
      descriptor: PropertyDescriptor,
    ): boolean {
      // Allow array index re-keying (e.g. when an array element is moved)
      if (
        prop === enPrefix &&
        enPrefix in target &&
        typeof descriptor.value === 'string' &&
        /\.\d+$/.test(descriptor.value)
      ) {
        return Reflect.set(target, prop, descriptor.value);
      }
      return Reflect.defineProperty(target, prop, descriptor);
    },
  };
}

// ─── Batch scheduling ─────────────────────────────────────────────────────────

function scheduleUpdate(ctx: EntropyContext, fn: () => void): void {
  if (ctx.batchQueue !== null) {
    ctx.batchQueue.push(fn);
  } else {
    fn();
  }
}

// ─── Computed propagation ─────────────────────────────────────────────────────

function updateComputed(ctx: EntropyContext, changedKey: string): void {
  const deps = getDependentsOf(ctx, changedKey);
  for (const dep of deps) {
    update(ctx, dep.computed, dep.key, false, dep.parent, dep.prop);
  }
}

// ─── Core update ─────────────────────────────────────────────────────────────

/**
 * The central propagation function. Called whenever a reactive value changes.
 * Resolves computed functions, handles async Promises, then notifies watchers
 * and directives.
 */
export function update(
  ctx: EntropyContext,
  value: unknown,
  key: string,
  isDelete: boolean,
  parent: Prefixed<object>,
  prop: string,
  syncConfig?: SyncConfig,
): void {
  if (ctx.destroyed) return;

  // If value is a computed function, run it
  if (
    typeof value === 'function' &&
    !ctx.computedResultFns.has(value as Function)
  ) {
    value = runComputed(ctx, value as Function, key, parent, prop);
    if (value === undefined) return; // async – will re-enter when resolved
  }

  // Async value: re-enter when the Promise resolves
  if (value instanceof Promise) {
    const version = bumpVersion(ctx, key);
    (value as Promise<unknown>).then((v: unknown) => {
      if (!isCurrentVersion(ctx, key, version)) return;
      update(ctx, v, key, false, parent, prop, syncConfig);
    });
    return;
  }

  if (!syncConfig) {
    callWatchers(ctx, key, value, (k) => getValue(ctx, k).value);
  }

  callDirectives(ctx, value, key, isDelete, parent, prop, undefined, undefined, syncConfig);
}

// ─── Computed helpers ─────────────────────────────────────────────────────────

function runComputed(
  ctx: EntropyContext,
  computedFn: Function,
  key: string,
  parent: Prefixed<object>,
  prop: string,
): unknown {
  const version = bumpVersion(ctx, key);
  const result = computedFn();

  if (result instanceof Promise) {
    result
      .then(v => {
        if (!isCurrentVersion(ctx, key, version)) return;
        const proxied = proxyComputed(ctx, v, key, parent, prop);
        update(ctx, proxied, key, false, parent, prop);
      })
      .catch(err =>
        console.error(`[entropy] Async computed error at "${key}":`, err),
      );
    return undefined;
  }

  return proxyComputed(ctx, result, key, parent, prop);
}

function proxyComputed(
  ctx: EntropyContext,
  value: unknown,
  key?: string,
  parent?: Prefixed<object>,
  prop?: string,
): unknown {
  if (typeof value === 'function') {
    // Tag function as a computed result so the get-trap won't call it again
    ctx.computedResultFns.add(value as Function);
    return value;
  }

  if (key === undefined || parent === undefined || prop === undefined) {
    return clone(value);
  }

  return reactive(ctx, clone(value), key, parent, prop);
}

// ─── callDirectives (split into focused sub-functions) ────────────────────────

function callDirectives(
  ctx: EntropyContext,
  value: unknown,
  key: string,
  isDelete: boolean,
  parent: Prefixed<object>,
  prop: string,
  searchRoot?: Element | Document,
  skipUpdateArrayElements?: boolean,
  syncConfig?: SyncConfig,
): void {
  const isParentArray = Array.isArray(parent);

  // Handle array item updates / length changes
  if (isParentArray && /^\d+$/.test(prop) && !skipUpdateArrayElements && syncConfig?.skipMark !== true) {
    updateArrayItemElement(ctx, key, prop, value, parent as Prefixed<unknown[]>);
  } else if (isParentArray && prop === 'length') {
    sortArrayItemElements(ctx, parent as Prefixed<unknown[]>);
  }

  // Recurse into reactive objects / arrays
  if (isPrefixedObject(value)) {
    if (Array.isArray(value) && syncConfig?.skipMark !== true) {
      callDirectivesForArray(ctx, value, key, isDelete, parent, prop, searchRoot, syncConfig);
    } else {
      callDirectivesForObject(ctx, value, key, isDelete, parent, prop, searchRoot);
    }
    // Also fire directives bound directly to this key (e.g. en-mark="obj" → JSON).
    // Arrays are handled separately via their placeholder mechanism.
    if (!Array.isArray(value)) {
      callDirectivesForLeaf(ctx, value, key, isDelete, parent, prop, searchRoot, syncConfig);
    }
    return;
  }

  // Primitive / non-reactive value – call matching directive callbacks
  callDirectivesForLeaf(ctx, value, key, isDelete, parent, prop, searchRoot, syncConfig);
}

function callDirectivesForArray(
  ctx: EntropyContext,
  value: Prefixed<unknown[]>,
  key: string,
  isDelete: boolean,
  parent: Prefixed<object>,
  prop: string,
  searchRoot?: Element | Document,
  syncConfig?: SyncConfig,
): void {
  const placeholderKey = `${key}.#`;
  const attrMark = ctx.prefix + 'mark';
  const query = `[${attrMark}="${placeholderKey}"]`;

  let target: Document | Element = document;
  if (syncConfig?.el.parentElement) {
    target = syncConfig.el.parentElement;
  }

  const elsArrays: Element[][] = [];
  queryAll(ctx, target, query).forEach(plc => {
    const els = initializeArrayElements(ctx, plc, placeholderKey, value);
    elsArrays.push(els);
  });

  for (const els of elsArrays) {
    for (const i in value) {
      callDirectives(
        ctx,
        value[i as unknown as number],
        getKey(i, key),
        isDelete,
        value,
        i,
        els[i as unknown as number] ?? undefined,
        true,
      );
    }
  }

  // Propagate to directives watching `key.length` (e.g. en-ifnot="items.length")
  callDirectivesForLeaf(
    ctx,
    value.length,
    getKey('length', key),
    isDelete,
    value as unknown as Prefixed<object>,
    'length',
    searchRoot,
  );
}

function callDirectivesForObject(
  ctx: EntropyContext,
  value: Prefixed<object>,
  key: string,
  isDelete: boolean,
  parent: Prefixed<object>,
  prop: string,
  searchRoot?: Element | Document,
): void {
  for (const k in value) {
    callDirectives(
      ctx,
      (value as Record<string, unknown>)[k],
      getKey(k, key),
      isDelete,
      value,
      k,
      searchRoot,
    );
  }
}

function callDirectivesForLeaf(
  ctx: EntropyContext,
  value: unknown,
  key: string,
  isDelete: boolean,
  parent: Prefixed<object>,
  prop: string,
  searchRoot?: Element | Document,
  syncConfig?: SyncConfig,
): void {
  if (syncConfig) {
    const { el, directive: attrSuffix, skipConditionals, skipMark } = syncConfig;
    if (
      (skipMark && attrSuffix === 'mark') ||
      (skipConditionals && (attrSuffix === 'if' || attrSuffix === 'ifnot'))
    ) {
      return;
    }
    const entry = ctx.directives.get(attrSuffix);
    if (!entry) return;
    const { cb, isParametric } = entry;
    const param = getParam(el, ctx.prefix + attrSuffix, !!isParametric);
    cb({ el, value, key, isDelete, parent, prop, param });
    return;
  }

  const root = searchRoot ?? document;

  for (const [attrSuffix, { cb, isParametric }] of ctx.directives) {
    const attrName = ctx.prefix + attrSuffix;
    const query = isParametric
      ? `[${attrName}^='${key}:']`
      : `[${attrName}='${key}']`;

    queryAll(ctx, root, query).forEach(el => {
      const param = getParam(el, attrName, !!isParametric);
      cb({ el, value, key, isDelete, parent, prop, param });
    });

    // Also check the search root itself when it is a concrete element
    if (root instanceof Element && root.getAttribute(attrName) === key) {
      const param = getParam(root, attrName, !!isParametric);
      cb({ el: root, value, key, isDelete, parent, prop, param });
    }
  }
}

// ─── Conditional directives (if / ifnot) ─────────────────────────────────────

function ifOrIfNot(
  ctx: EntropyContext,
  el: Element,
  value: unknown,
  key: string,
  type: 'if' | 'ifnot',
): void {
  const isShow = type === 'if' ? !!value : !value;
  const isTemplate = el instanceof HTMLTemplateElement;
  const attrType = ctx.prefix + type;
  const attrMark = ctx.prefix + 'mark';

  if (isShow && isTemplate) {
    const children = Array.from(el.content.children);
    if (!children.length) return;

    // Mark every child with the directive attr so they can be collected back
    // into a template when the condition flips. Use a DocumentFragment so
    // all children are inserted in a single DOM operation.
    const fragment = document.createDocumentFragment();
    children.forEach(child => {
      child.setAttribute(attrType, key);
      syncNode(ctx, child, true);
      fragment.appendChild(child.cloneNode(true));
    });
    el.replaceWith(fragment);
  }

  if (!isShow && !isTemplate) {
    // Collect this element AND any following siblings that share the same
    // directive key (i.e. were part of the same multi-child template).
    const siblings: Element[] = [el];
    let next = el.nextElementSibling;
    while (next && next.getAttribute(ctx.prefix + type) === key) {
      siblings.push(next);
      next = next.nextElementSibling;
    }

    const temp = document.createElement('template');
    siblings.forEach(s => temp.content.appendChild(s.cloneNode(true)));
    temp.setAttribute(attrType, key);

    const mark = el.getAttribute(attrMark);
    if (mark) temp.setAttribute(attrMark, mark);

    // Replace first sibling with template, remove the rest
    el.replaceWith(temp);
    siblings.slice(1).forEach(s => s.remove());
  }
}

// ─── Sync helpers ─────────────────────────────────────────────────────────────

/**
 * Recursively syncs an element tree that is about to be inserted into the DOM
 * (called from `if`/`ifnot` before insertion). Evaluates conditionals on the
 * way down but skips `mark` – actual values are filled in by `syncClone`.
 */
function syncNode(
  ctx: EntropyContext,
  el: Element,
  isSyncRoot: boolean,
): void {
  Array.from(el.children).forEach(child => syncNode(ctx, child, false));
  syncDirectives(ctx, el, isSyncRoot, false);
}

/**
 * Recursively syncs a clone that has already been inserted. Skips
 * conditionals (already evaluated during `syncNode`) and processes `mark`.
 */
function syncClone(ctx: EntropyContext, clone: Element): void {
  Array.from(clone.children).forEach(child => syncClone(ctx, child));
  syncDirectives(ctx, clone, false, true);
}

function syncDirectives(
  ctx: EntropyContext,
  el: Element,
  skipConditionals?: boolean,
  skipMark?: boolean,
): void {
  for (const [name] of ctx.directives) {
    if (skipMark && name === 'mark') continue;
    if (skipConditionals && (name === 'if' || name === 'ifnot')) continue;

    const { isParametric } = ctx.directives.get(name)!;
    const attrFull = ctx.prefix + name;
    let key = el.getAttribute(attrFull);

    if (isParametric) key = key?.split(':')[0] ?? null;
    if (key?.endsWith('.#')) key = key.slice(0, -2);
    if (key === null) continue;

    const { value, parent, prop } = getValue(ctx, key);
    if (!parent) continue;

    update(ctx, value, key, false, parent, prop, {
      directive: name,
      el,
      ...(skipConditionals !== undefined ? { skipConditionals } : {}),
      ...(skipMark !== undefined ? { skipMark } : {}),
    });
  }
}

// ─── Array DOM management ─────────────────────────────────────────────────────

function updateArrayItemElement(
  ctx: EntropyContext,
  key: string,
  idx: string,
  item: unknown,
  array: Prefixed<unknown[]>,
): void {
  const attrMark = ctx.prefix + 'mark';
  const arrayItems = document.querySelectorAll(`[${attrMark}="${key}"]`);

  if (arrayItems.length && !isPrefixedObject(item)) {
    // Primitives: innerText update is sufficient, no DOM replacement needed
    return;
  }

  const prefix = ((array as unknown as Record<symbol, string>)[enPrefix]) ?? '';
  const placeholderKey = key.replace(/\d+$/, '#');
  let itemReplaced = false;

  // Replace existing DOM items that map to this array index
  Array.from(arrayItems).forEach(existingEl => {
    const cl = cloneFromPlaceholder(ctx, existingEl, placeholderKey, attrMark);
    if (!cl) return;

    initializeClone(ctx, idx, prefix, placeholderKey, cl);
    existingEl.replaceWith(cl);
    syncClone(ctx, cl);
    itemReplaced = true;
  });

  if (itemReplaced) return;

  // No existing item – insert before the template placeholder
  Array.from(document.querySelectorAll(`[${attrMark}="${placeholderKey}"]`)).forEach(template => {
    if (!(template instanceof HTMLTemplateElement)) return;
    const clone = template.content.firstElementChild?.cloneNode(true);
    if (!(clone instanceof Element)) return;

    initializeClone(ctx, idx, prefix, placeholderKey, clone);
    template.before(clone);
    syncClone(ctx, clone);
  });
}

function cloneFromPlaceholder(
  ctx: EntropyContext,
  item: Element,
  placeholderKey: string,
  attrMark: string,
): Element | null {
  let placeholder = item.nextElementSibling;
  while (placeholder) {
    if (placeholder.getAttribute(attrMark) === placeholderKey) break;
    placeholder = placeholder.nextElementSibling;
  }

  if (placeholder instanceof HTMLTemplateElement) {
    const c = placeholder.content.firstElementChild?.cloneNode(true);
    return c instanceof Element ? c : null;
  }
  if (placeholder?.getAttribute(attrMark) === placeholderKey) {
    return placeholder.cloneNode(true) as Element;
  }
  return null;
}

function sortArrayItemElements(
  ctx: EntropyContext,
  array: Prefixed<unknown[]>,
): void {
  const attrMark = ctx.prefix + 'mark';
  const templateKey = getKey('#', ((array as unknown as Record<symbol, string>)[enPrefix]) ?? '');
  Array.from(document.querySelectorAll(`[${attrMark}="${templateKey}"]`)).forEach(template => {
    const items: Element[] = [];
    let prev = template.previousElementSibling;
    let isSorted = true;
    let lastIdx = -1;

    while (prev) {
      const curr = prev;
      prev = curr.previousElementSibling;

      const k = curr.getAttribute(attrMark);
      if (!k) continue;
      if (k === templateKey) break;

      if (k.replace(/\d+$/, '#') === templateKey) {
        items.push(curr);
        if (isSorted) {
          const idx = Number(k.slice(k.lastIndexOf('.') + 1) ?? -1);
          if (lastIdx !== -1 && lastIdx !== idx + 1) isSorted = false;
          lastIdx = idx;
        }
      }
    }

    if (isSorted) return;

    const sorted = [...items].sort((a, b) => {
      const am = a.getAttribute(attrMark) ?? '';
      const bm = b.getAttribute(attrMark) ?? '';
      const ai = +(am.split('.').pop() ?? 0);
      const bi = +(bm.split('.').pop() ?? 0);
      return ai - bi;
    });

    sorted.forEach(el => template.before(el));
  });
}

function initializeArrayElements(
  ctx: EntropyContext,
  plc: Element,
  placeholderKey: string,
  array: unknown[],
): Element[] {
  const attrMark = ctx.prefix + 'mark';

  // ── 1. Remove previous item elements ────────────────────────────────────
  let prev = plc.previousElementSibling;
  while (prev) {
    const curr = prev;
    prev = curr.previousElementSibling;
    const k = curr.getAttribute(attrMark);
    if (!k) continue;
    if (k !== placeholderKey && k.replace(/\d+$/, '#') === placeholderKey) {
      curr.remove();
    } else {
      break;
    }
  }

  // ── 2. Resolve template and placeholder ──────────────────────────────────
  let template: HTMLTemplateElement;
  let placeholder: Element | null;

  if (plc instanceof HTMLTemplateElement) {
    template = plc;
    placeholder = plc.content.firstElementChild;
    placeholder?.setAttribute(attrMark, placeholderKey);
  } else {
    placeholder = plc;
    template = document.createElement('template');
    template.content.appendChild(plc.cloneNode(true));
    template.setAttribute(attrMark, placeholderKey);
    plc.replaceWith(template);
  }

  if (!placeholder) {
    console.warn(`[entropy] Empty template for key "${placeholderKey}"`);
    return [];
  }

  // ── 3. Create one element per array item ─────────────────────────────────
  const prefix = placeholderKey.slice(0, -2); // strip ".#"
  const elements: Element[] = [];

  for (const idx in array) {
    if (Number.isNaN(+idx)) continue;

    const clone = placeholder.cloneNode(true);
    if (!(clone instanceof Element)) continue;

    initializeClone(ctx, idx, prefix, placeholderKey, clone);
    template.before(clone);
    syncClone(ctx, clone);
    elements.push(clone);
  }

  return elements;
}

function initializeClone(
  ctx: EntropyContext,
  idx: string,
  prefix: string,
  placeholderKey: string,
  clone: Element,
): void {
  const key = getKey(idx, prefix);

  for (const attrSuffix of ctx.directives.keys()) {
    const attrName = ctx.prefix + attrSuffix;
    rewriteKey(clone, attrName, key, placeholderKey);
    clone.querySelectorAll(`[${attrName}]`).forEach(child => {
      rewriteKey(child, attrName, key, placeholderKey);
    });
  }
}

function rewriteKey(
  el: Element,
  attrName: string,
  key: string,
  placeholderKey: string,
): void {
  const current = el.getAttribute(attrName);
  if (current?.startsWith(placeholderKey)) {
    el.setAttribute(attrName, key + current.slice(placeholderKey.length));
  }
}

// ─── Batch API ────────────────────────────────────────────────────────────────

/**
 * Runs `fn` synchronously while collecting all DOM updates into a queue,
 * then flushes the queue in one pass. Useful when multiple properties are
 * changed at once.
 *
 * @example
 * ```ts
 * en.batch(() => {
 *   data.firstName = 'John';
 *   data.lastName  = 'Doe';
 * });
 * ```
 */
export function batch(ctx: EntropyContext, fn: () => void): void {
  ctx.batchQueue = [];
  try {
    fn();
  } finally {
    const queue = ctx.batchQueue ?? [];
    ctx.batchQueue = null;
    for (const task of queue) task();
  }
}

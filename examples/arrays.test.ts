import { describe, it, expect } from 'vitest';
import { setup } from './helpers';

// ─── Array rendering ──────────────────────────────────────────────────────────

describe('Array rendering', () => {
  it('renders initial array items into the DOM', () => {
    const { data, qAll, cleanup } = setup(`
      <ul>
        <li en-mark="items.#"></li>
      </ul>
    `);

    data.items = ['apple', 'banana', 'cherry'];
    const lis = qAll('li:not([en-mark$=".#"])');
    // 3 real items + 1 template placeholder = qAll finds items with concrete keys
    const items = qAll<HTMLElement>('li[en-mark^="items."][en-mark$="items.#"]');
    // simpler: just count li elements that are NOT the template
    const realLis = qAll<HTMLElement>('li').filter(
      el => !el.getAttribute('en-mark')?.endsWith('#')
    );
    expect(realLis.length).toBe(3);
    cleanup();
  });

  it('push adds a new element to the DOM', () => {
    const { data, container, cleanup } = setup(`
      <ul><li en-mark="list.#"></li></ul>
    `);

    data.list = ['a', 'b'];
    const before = container.querySelectorAll(
      'li:not([en-mark$="#"])'
    ).length;

    data.list.push('c');

    const after = container.querySelectorAll(
      'li:not([en-mark$="#"])'
    ).length;

    expect(after).toBe(before + 1);
    cleanup();
  });

  it('replaces all items when array is reassigned', () => {
    const { data, container, cleanup } = setup(`
      <ul><li en-mark="items.#"></li></ul>
    `);

    data.items = ['x', 'y', 'z'];
    data.items = ['only'];

    const realLis = Array.from(
      container.querySelectorAll('li')
    ).filter(el => !el.getAttribute('en-mark')?.endsWith('#'));

    expect(realLis.length).toBe(1);
    cleanup();
  });
});

// ─── en-ifnot with empty array ────────────────────────────────────────────────

describe('Empty list conditional', () => {
  it('shows empty state template when array has no items', () => {
    const { data, container, cleanup } = setup(`
      <ul><li en-mark="items.#"></li></ul>
      <template en-ifnot="items.length">
        <p id="empty">No items</p>
      </template>
    `);

    data.items = [];
    expect(container.querySelector('#empty')).not.toBeNull();
    cleanup();
  });

  it('hides empty state when items are added', () => {
    const { data, container, cleanup } = setup(`
      <ul><li en-mark="items.#"></li></ul>
      <template en-ifnot="items.length">
        <p id="empty">No items</p>
      </template>
    `);

    data.items = [];
    data.items.push('first');

    expect(container.querySelector('#empty')).toBeNull();
    cleanup();
  });
});

// ─── Object arrays ────────────────────────────────────────────────────────────

describe('Object array rendering', () => {
  it('renders nested keys for object arrays', () => {
    const { data, qAll, cleanup } = setup(`
      <ul>
        <li en-mark="users.#">
          <strong en-mark="users.#.name"></strong>
          <span en-mark="users.#.email"></span>
        </li>
      </ul>
    `);

    data.users = [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob',   email: 'bob@example.com'   },
    ];

    const names  = qAll<HTMLElement>('strong').map(el => el.textContent);
    const emails = qAll<HTMLElement>('span').map(el => el.textContent);

    expect(names).toEqual(['Alice', 'Bob']);
    expect(emails).toEqual(['alice@example.com', 'bob@example.com']);
    cleanup();
  });

  it('updates a nested key when an object property changes', () => {
    const { data, q, cleanup } = setup(`
      <ul>
        <li en-mark="users.#">
          <strong en-mark="users.#.name"></strong>
        </li>
      </ul>
    `);

    data.users = [{ name: 'Alice' }, { name: 'Bob' }];
    data.users[0].name = 'Alicia';

    const names = Array.from(document.querySelectorAll('strong'))
      .map(el => el.textContent);
    expect(names[0]).toBe('Alicia');
    cleanup();
  });

  it('splice removes the correct DOM element', () => {
    const { data, container, cleanup } = setup(`
      <ul><li en-mark="items.#"></li></ul>
    `);

    data.items = ['a', 'b', 'c'];
    data.items.splice(1, 1); // remove 'b'

    const realLis = Array.from(container.querySelectorAll('li'))
      .filter(el => !el.getAttribute('en-mark')?.endsWith('#'));

    expect(realLis.length).toBe(2);
    cleanup();
  });

  it('index assignment updates the correct element in place', () => {
    const { data, container, cleanup } = setup(`
      <ul><li en-mark="items.#"></li></ul>
    `);

    data.items = ['a', 'b', 'c'];
    data.items[1] = 'UPDATED';

    const realLis = Array.from(container.querySelectorAll('li'))
      .filter(el => !el.getAttribute('en-mark')?.endsWith('#'));

    expect(realLis[1]?.textContent).toBe('UPDATED');
    cleanup();
  });
});

// ─── Computed over arrays ─────────────────────────────────────────────────────

describe('Computed filtering and sorting', () => {
  it('filtered computed updates DOM when source array changes', () => {
    const { en, data, container, cleanup } = setup(`
      <ul><li en-mark="visible.#"></li></ul>
    `);

    data.all     = ['apple', 'banana', 'apricot', 'cherry'];
    data.visible = en.computed(() =>
      data.all.filter((x: string) => x.startsWith('a'))
    );

    const count = () => Array.from(container.querySelectorAll('li'))
      .filter(el => !el.getAttribute('en-mark')?.endsWith('#')).length;

    expect(count()).toBe(2); // apple, apricot

    data.all = [...data.all, 'avocado'];
    expect(count()).toBe(3); // apple, apricot, avocado
    cleanup();
  });

  it('sorted computed renders items in correct order', () => {
    const { en, data, qAll, cleanup } = setup(`
      <ul><li en-mark="sorted.#"></li></ul>
    `);

    data.raw    = ['banana', 'apple', 'cherry'];
    data.sorted = en.computed(() =>
      [...data.raw].sort((a: string, b: string) => a.localeCompare(b))
    );

    const texts = qAll<HTMLElement>('li')
      .filter(el => !el.getAttribute('en-mark')?.endsWith('#'))
      .map(el => el.textContent);

    expect(texts).toEqual(['apple', 'banana', 'cherry']);
    cleanup();
  });
});

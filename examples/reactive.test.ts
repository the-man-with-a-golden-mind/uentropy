import { describe, it, expect } from 'vitest';
import { setup } from './helpers';

// ─── Basic reactivity ────────────────────────────────────────────────────────

describe('Reactive data', () => {
  it('sets and reads primitive values', () => {
    const { data, cleanup } = setup();
    data.name = 'Alice';
    expect(data.name).toBe('Alice');
    cleanup();
  });

  it('sets and reads nested objects', () => {
    const { data, cleanup } = setup();
    data.user = { name: 'Bob', age: 30 };
    expect(data.user.name).toBe('Bob');
    expect(data.user.age).toBe(30);
    cleanup();
  });

  it('supports delete', () => {
    const { data, cleanup } = setup();
    data.temp = 'remove me';
    delete data.temp;
    expect(data.temp).toBeUndefined();
    cleanup();
  });

  it('handles arrays', () => {
    const { data, cleanup } = setup();
    data.items = ['a', 'b', 'c'];
    expect(data.items[0]).toBe('a');
    expect(data.items.length).toBe(3);
    cleanup();
  });

  it('supports array push', () => {
    const { data, cleanup } = setup();
    data.list = [1, 2];
    data.list.push(3);
    expect(data.list.length).toBe(3);
    expect(data.list[2]).toBe(3);
    cleanup();
  });
});

// ─── en-mark directive ───────────────────────────────────────────────────────

describe('en-mark directive', () => {
  it('sets innerText when value is set', () => {
    const { data, q, cleanup } = setup(`<span en-mark="count">0</span>`);
    data.count = 42;
    expect(q('span').textContent).toBe('42');
    cleanup();
  });

  it('updates innerText on value change', () => {
    const { data, q, cleanup } = setup(`<span en-mark="name">—</span>`);
    data.name = 'Alice';
    expect(q('span').textContent).toBe('Alice');
    data.name = 'Bob';
    expect(q('span').textContent).toBe('Bob');
    cleanup();
  });

  it('serialises objects to JSON', () => {
    const { data, q, cleanup } = setup(`<span en-mark="obj"></span>`);
    data.obj = { x: 1 };
    expect(q('span').textContent).toBe('{"x":1}');
    cleanup();
  });

  it('updates nested key', () => {
    const { data, q, cleanup } = setup(`<span en-mark="user.name"></span>`);
    data.user = { name: 'Charlie' };
    expect(q('span').textContent).toBe('Charlie');
    cleanup();
  });
});

// ─── en-if / en-ifnot ────────────────────────────────────────────────────────

describe('en-if directive', () => {
  it('replaces template with child when value is truthy', () => {
    const { data, container, cleanup } = setup(
      `<template en-if="show"><p id="p">Hello</p></template>`
    );
    data.show = true;
    expect(container.querySelector('#p')).not.toBeNull();
    cleanup();
  });

  it('puts element back in template when value becomes falsy', () => {
    const { data, container, cleanup } = setup(
      `<template en-if="show"><p id="p">Hello</p></template>`
    );
    data.show = true;
    data.show = false;
    expect(container.querySelector('#p')).toBeNull();
    expect(container.querySelector('template[en-if]')).not.toBeNull();
    cleanup();
  });
});

describe('en-ifnot directive', () => {
  it('shows element when value is falsy', () => {
    const { data, container, cleanup } = setup(
      `<template en-ifnot="busy"><p id="idle">Ready</p></template>`
    );
    data.busy = false;
    expect(container.querySelector('#idle')).not.toBeNull();
    cleanup();
  });

  it('hides element when value becomes truthy', () => {
    const { data, container, cleanup } = setup(
      `<template en-ifnot="busy"><p id="idle">Ready</p></template>`
    );
    data.busy = false;
    data.busy = true;
    expect(container.querySelector('#idle')).toBeNull();
    cleanup();
  });
});

describe('en-if / en-ifnot — multiple root children', () => {
  it('inserts all children from a multi-child template', () => {
    const { data, container, cleanup } = setup(
      `<template en-if="show">
        <input id="inp" type="email" />
        <button id="btn">Submit</button>
      </template>`
    );
    data.show = true;
    expect(container.querySelector('#inp')).not.toBeNull();
    expect(container.querySelector('#btn')).not.toBeNull();
    cleanup();
  });

  it('removes all children when condition flips to false', () => {
    const { data, container, cleanup } = setup(
      `<template en-if="show">
        <input id="inp" />
        <button id="btn">Submit</button>
      </template>`
    );
    data.show = true;
    data.show = false;
    expect(container.querySelector('#inp')).toBeNull();
    expect(container.querySelector('#btn')).toBeNull();
    expect(container.querySelector('template[en-if]')).not.toBeNull();
    cleanup();
  });

  it('can toggle multiple times correctly', () => {
    const { data, container, cleanup } = setup(
      `<template en-if="show">
        <p id="a">A</p>
        <p id="b">B</p>
        <p id="c">C</p>
      </template>`
    );
    data.show = true;
    expect(container.querySelectorAll('p').length).toBe(3);
    data.show = false;
    expect(container.querySelectorAll('p').length).toBe(0);
    data.show = true;
    expect(container.querySelectorAll('p').length).toBe(3);
    cleanup();
  });

  it('en-ifnot inserts all children when value is falsy', () => {
    const { data, container, cleanup } = setup(
      `<template en-ifnot="busy">
        <input id="inp" />
        <button id="btn">Go</button>
      </template>`
    );
    data.busy = false;
    expect(container.querySelector('#inp')).not.toBeNull();
    expect(container.querySelector('#btn')).not.toBeNull();
    cleanup();
  });
});

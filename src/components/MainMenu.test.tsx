// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MainMenu } from './MainMenu';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const items = [{ label: 'Settings', icon: '', onSelect: () => {} }];

describe('main menu immediate dismissal', () => {
  it('accepts Escape immediately after opening and after an ordinary parent render', () => {
    const firstClose = vi.fn();
    act(() => root.render(<MainMenu open onClose={firstClose} items={items} />));
    expect(document.activeElement).toBe(container.querySelector('[role="menuitem"]'));
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(firstClose).toHaveBeenCalledTimes(1);

    const nextClose = vi.fn();
    act(() => root.render(<MainMenu open onClose={nextClose} items={items} />));
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(nextClose).toHaveBeenCalledTimes(1);
    expect(firstClose).toHaveBeenCalledTimes(1);
  });

  it('ignores the opener and dismisses on an outside pointerdown without waiting a frame', () => {
    const onClose = vi.fn();
    act(() =>
      root.render(
        <>
          <button aria-haspopup="menu">Menu</button>
          <MainMenu open onClose={onClose} items={items} />
        </>,
      ),
    );
    act(() =>
      container
        .querySelector('[aria-haspopup="menu"]')!
        .dispatchEvent(new Event('pointerdown', { bubbles: true })),
    );
    expect(onClose).not.toHaveBeenCalled();
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector } from './Inspector';
import { makeNode } from '../sim/presets';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('connection-only selection in the inspector', () => {
  it.each([1, 3])('deletes %i selected connections by button', (count) => {
    const deleteConnections = vi.fn();
    const deleteNode = vi.fn();
    act(() =>
      root.render(
        <Inspector
          node={null}
          stats={null}
          onChange={() => {}}
          onDelete={deleteNode}
          onRename={() => {}}
          selectedEdgeCount={count}
          onDeleteConnections={deleteConnections}
        />,
      ),
    );

    const button = container.querySelector('button');
    expect(button?.textContent).toBe(
      count === 1 ? 'Delete connection' : 'Delete 3 connections',
    );
    expect(container.textContent).not.toContain('Press Delete');
    act(() => button?.click());
    expect(deleteConnections).toHaveBeenCalledTimes(1);
    expect(deleteNode).not.toHaveBeenCalled();
  });

  it.each([null, makeNode('service', 0, 0)])(
    'does not offer connection deletion without an edge-only selection',
    (node) => {
      const deleteConnections = vi.fn();
      act(() =>
        root.render(
          <Inspector
            node={node}
            stats={null}
            onChange={() => {}}
            onDelete={() => {}}
            onRename={() => {}}
            selectedEdgeCount={node ? 1 : 0}
            onDeleteConnections={deleteConnections}
          />,
        ),
      );
      expect(container.textContent).not.toMatch(/Delete (connection|\d+ connections)/);
      expect(deleteConnections).not.toHaveBeenCalled();
    },
  );
});

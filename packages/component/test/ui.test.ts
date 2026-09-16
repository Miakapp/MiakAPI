import { describe, expect, test } from 'bun:test';
import { LIMITS, UiError, checkTree, ui, type UiNode } from '../src/index.js';

describe('node construction', () => {
  test('an optional property is omitted rather than sent as undefined', () => {
    expect(ui.text({ id: 'hint', text: 'Hello' }).props).toEqual({ text: 'Hello' });
    expect(ui.text({ id: 'hint', text: 'Hello', tone: 'muted' }).props)
      .toEqual({ text: 'Hello', tone: 'muted' });
  });

  test('a stack with no options carries no property at all', () => {
    expect(ui.stack({ id: 'rows' }, []).props).toEqual({});
  });

  test('select options are copied to exactly value and label', () => {
    const node = ui.select({
      id: 'mode',
      label: 'Mode',
      value: 'eco',
      options: [{ value: 'eco', label: 'Eco' }, { value: 'comfort', label: 'Comfort' }],
      handler: 'mode',
    });
    expect(node.props['options']).toEqual([
      { value: 'eco', label: 'Eco' },
      { value: 'comfort', label: 'Comfort' },
    ]);
  });

  test('a node ID outside the ABI charset is refused', () => {
    expect(() => ui.text({ id: '1bad', text: 'x' })).toThrow(UiError);
    expect(() => ui.text({ id: 'a b', text: 'x' })).toThrow(UiError);
    expect(() => ui.text({ id: 'a'.repeat(65), text: 'x' })).toThrow(UiError);
    expect(ui.text({ id: 'a.b:c-d_0', text: 'x' }).id).toBe('a.b:c-d_0');
  });

  test('an interactive node needs a handler', () => {
    expect(() => ui.button({ id: 'go', label: 'Turn on' })).toThrow(/handler/);
  });

  test('a handler callback outside a render is refused with a usable message', () => {
    expect(() => ui.button({ id: 'go', label: 'Turn on', onPress: () => undefined }))
      .toThrow(/outside a render/);
  });

  test('a handler ID works without a render scope', () => {
    expect(ui.button({ id: 'go', label: 'Turn on', handler: 'go' }).props['handler']).toBe('go');
  });
});

describe('tree invariants', () => {
  function nested(depth: number): UiNode {
    let node = ui.text({ id: 'leaf', text: 'x' });
    for (let level = depth; level > 0; level -= 1) {
      node = ui.stack({ id: `level${level}` }, [node]);
    }
    return ui.screen({ title: 'Living room' }, [node]);
  }

  test('the root must be a screen', () => {
    expect(() => checkTree(ui.text({ id: 'lonely', text: 'x' }))).toThrow(/root node must be a screen/);
  });

  test('duplicate node IDs are caught before the broker terminates the instance', () => {
    const tree = ui.screen({ title: 'Living room' }, [
      ui.text({ id: 'same', text: 'one' }),
      ui.text({ id: 'same', text: 'two' }),
    ]);
    expect(() => checkTree(tree)).toThrow(/Duplicate node ID: same/);
  });

  test('a tree at the depth limit is accepted and one past it is not', () => {
    expect(() => checkTree(nested(LIMITS.uiDepth - 2))).not.toThrow();
    expect(() => checkTree(nested(LIMITS.uiDepth + 1))).toThrow(/deeper than/);
  });

  test('too many nodes is refused', () => {
    const children = Array.from(
      { length: LIMITS.uiNodes },
      (_unused, index) => ui.text({ id: `t${index}`, text: 'x' }),
    );
    expect(() => checkTree(ui.screen({ title: 'Living room' }, children))).toThrow(/more than/);
  });

  test('one oversized text is refused', () => {
    const tree = ui.screen({ title: 'Living room' }, [
      ui.text({ id: 'long', text: 'é'.repeat(LIMITS.textBytes) }),
    ]);
    expect(() => checkTree(tree)).toThrow(/exceeds 8192 UTF-8 bytes/);
  });

  test('aggregate text above the budget is refused', () => {
    const block = 'a'.repeat(LIMITS.textBytes);
    const children = Array.from(
      { length: Math.ceil(LIMITS.uiTextBytes / LIMITS.textBytes) },
      (_unused, index) => ui.text({ id: `t${index}`, text: block }),
    );
    expect(() => checkTree(ui.screen({ title: 'Living room' }, children)))
      .toThrow(/Aggregate UI text/);
  });

  test('a valid tree is returned unchanged', () => {
    const tree = ui.screen({ title: 'Living room' }, [
      ui.section({ id: 'lights', heading: 'Lights' }, [
        ui.toggle({ id: 'lamp', label: 'Lamp', value: true, handler: 'lamp' }),
        ui.progress({ id: 'dim', label: 'Intensity', value: 0.5 }),
      ]),
    ]);
    expect(checkTree(tree)).toBe(tree);
  });
});

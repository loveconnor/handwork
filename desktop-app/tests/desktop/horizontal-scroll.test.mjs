import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindHorizontalWheel } from '../../lib/horizontal-scroll.ts';

function fixture() {
  const strip = Object.assign(new EventTarget(), { scrollLeft: 0, scrollWidth: 1000, clientWidth: 200 });
  const cleanup = bindHorizontalWheel(strip);
  const wheel = (values = {}) => {
    const event = Object.assign(new Event('wheel', { cancelable: true }), { deltaX: 0, deltaY: 50, deltaMode: 0, ctrlKey: false, shiftKey: false }, values);
    strip.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { strip, wheel, cleanup };
}

test('mouse wheel traverses tabs in both directions and clamps at either end', () => {
  const { strip, wheel, cleanup } = fixture();
  assert.equal(wheel(), true);
  assert.equal(strip.scrollLeft, 50);
  assert.equal(wheel({ deltaY: -20 }), true);
  assert.equal(strip.scrollLeft, 30);
  wheel({ deltaY: 10000 });
  assert.equal(strip.scrollLeft, 800);
  assert.equal(wheel(), false);
  wheel({ deltaY: -10000 });
  assert.equal(strip.scrollLeft, 0);
  assert.equal(wheel({ deltaY: -50 }), false);
  cleanup();
  wheel();
  assert.equal(strip.scrollLeft, 0);
});

test('line and page wheel units are normalized', () => {
  const { strip, wheel, cleanup } = fixture();
  wheel({ deltaMode: 1, deltaY: 2 });
  assert.equal(strip.scrollLeft, 32);
  wheel({ deltaMode: 2, deltaY: 1 });
  assert.equal(strip.scrollLeft, 232);
  cleanup();
});

test('zoom, zero delta and non-overflowing tabs are untouched', () => {
  const { strip, wheel, cleanup } = fixture();
  for (const values of [{ ctrlKey: true }, { deltaY: 0 }]) {
    assert.equal(wheel(values), false);
    assert.equal(strip.scrollLeft, 0);
  }
  strip.scrollWidth = strip.clientWidth;
  assert.equal(wheel(), false);
  assert.equal(strip.scrollLeft, 0);
  cleanup();
});

test('horizontal, mixed-axis and Shift-wheel gestures move tabs without double-counting deltas', () => {
  const { strip, wheel, cleanup } = fixture();
  assert.equal(wheel({ deltaX: 60, deltaY: 0 }), true);
  assert.equal(strip.scrollLeft, 60);
  wheel({ deltaX: 2, deltaY: 50 });
  assert.equal(strip.scrollLeft, 110);
  wheel({ deltaX: 80, deltaY: 2 });
  assert.equal(strip.scrollLeft, 190);
  wheel({ shiftKey: true, deltaY: 40 });
  assert.equal(strip.scrollLeft, 230);
  wheel({ deltaX: -30, deltaY: 0 });
  assert.equal(strip.scrollLeft, 200);
  cleanup();
});

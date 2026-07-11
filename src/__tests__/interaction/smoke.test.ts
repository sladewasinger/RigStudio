import { describe, it, expect } from 'vitest';

// Bare-minimum check that Vitest Browser Mode boots a real DOM with layout APIs the
// harness depends on (elementFromPoint / getScreenCTM / getBBox). If this fails the
// whole interaction suite is unusable and we fall back to the runner-page pattern.
describe('browser-mode smoke', () => {
  it('has a real layout engine', () => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:20px;top:30px;width:40px;height:50px';
    document.body.appendChild(el);
    const hit = document.elementFromPoint(40, 55);
    expect(hit).toBe(el);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.appendChild(svg);
    expect(svg.getScreenCTM()).not.toBeNull();
    el.remove();
    svg.remove();
  });

  it('has the expected viewport width', () => {
    expect(window.innerWidth).toBeGreaterThanOrEqual(1200);
  });
});

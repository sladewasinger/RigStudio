/**
 * Resolve the SVG `display`/`visibility` cascade before import strips the source DOM.
 * Presentation attributes, author stylesheets and inline styles participate in their
 * normal precedence; `display:none` suppresses a whole subtree while `visibility` is
 * inherited and may be overridden by a descendant (`visibility:visible`).
 */

interface Declaration {
  property: 'display' | 'visibility';
  value: string;
  important: boolean;
}

interface Rule {
  selector: string;
  declarations: Declaration[];
  specificity: number;
  order: number;
}

interface Candidate extends Declaration {
  specificity: number;
  order: number;
}

const DRAWABLE_TAGS = new Set(['path', 'ellipse', 'circle', 'rect']);

export class SvgVisibilityResolver {
  private readonly rules: Rule[];
  private readonly ownCache = new WeakMap<Element, Map<string, string>>();
  private readonly visibilityCache = new WeakMap<Element, string>();
  private readonly displayCache = new WeakMap<Element, boolean>();

  constructor(root: Element) {
    this.rules = stylesheetRules(root);
  }

  isHidden(element: Element): boolean {
    return this.isDisplaySuppressed(element) || hiddenVisibility(this.computedVisibility(element));
  }

  hasVisibleDrawable(element: Element): boolean {
    if (DRAWABLE_TAGS.has(element.tagName) && !this.isHidden(element)) return true;
    return Array.from(element.children).some((child) => this.hasVisibleDrawable(child));
  }

  private computedVisibility(element: Element): string {
    const cached = this.visibilityCache.get(element);
    if (cached !== undefined) return cached;
    const own = this.ownProperties(element).get('visibility');
    const parent = element.parentElement;
    const inherited = parent ? this.computedVisibility(parent) : 'visible';
    const value = !own || own === 'inherit' || own === 'unset'
      ? inherited
      : own === 'initial' || own === 'revert' ? 'visible' : own;
    this.visibilityCache.set(element, value);
    return value;
  }

  private isDisplaySuppressed(element: Element): boolean {
    const cached = this.displayCache.get(element);
    if (cached !== undefined) return cached;
    const parent = element.parentElement;
    const hidden = this.ownProperties(element).get('display') === 'none'
      || !!parent && this.isDisplaySuppressed(parent);
    this.displayCache.set(element, hidden);
    return hidden;
  }

  private ownProperties(element: Element): Map<string, string> {
    const cached = this.ownCache.get(element);
    if (cached) return cached;
    const candidates: Candidate[] = [];
    for (const property of ['display', 'visibility'] as const) {
      const value = element.getAttribute(property);
      if (value !== null) candidates.push({
        property, value: value.trim().toLowerCase(), important: false, specificity: 0, order: -1,
      });
    }
    for (const rule of this.rules) {
      if (!matches(element, rule.selector)) continue;
      for (const declaration of rule.declarations) {
        candidates.push({ ...declaration, specificity: rule.specificity, order: rule.order });
      }
    }
    for (const declaration of declarationsOf(element.getAttribute('style') ?? '')) {
      candidates.push({ ...declaration, specificity: 1_000_000, order: Number.MAX_SAFE_INTEGER });
    }
    candidates.sort((a, b) =>
      Number(a.important) - Number(b.important)
      || a.specificity - b.specificity
      || a.order - b.order);
    const properties = new Map<string, string>();
    for (const candidate of candidates) properties.set(candidate.property, candidate.value);
    this.ownCache.set(element, properties);
    return properties;
  }
}

function hiddenVisibility(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'hidden' || normalized === 'collapse';
}

function declarationsOf(text: string): Declaration[] {
  const declarations: Declaration[] = [];
  for (const source of text.split(';')) {
    const colon = source.indexOf(':');
    if (colon < 0) continue;
    const property = source.slice(0, colon).trim().toLowerCase();
    if (property !== 'display' && property !== 'visibility') continue;
    const important = /!important\s*$/i.test(source.slice(colon + 1));
    const value = source.slice(colon + 1).replace(/!important\s*$/i, '').trim().toLowerCase();
    if (value) declarations.push({ property, value, important });
  }
  return declarations;
}

function stylesheetRules(root: Element): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  for (const style of Array.from(root.querySelectorAll('style'))) {
    const css = (style.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = declarationsOf(match[2]);
      if (declarations.length === 0) continue;
      for (const selector of splitSelectors(match[1])) {
        rules.push({ selector, declarations, specificity: specificityOf(selector), order: order++ });
      }
    }
  }
  return rules;
}

function splitSelectors(source: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      selectors.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(source.slice(start).trim());
  return selectors.filter(Boolean);
}

function specificityOf(selector: string): number {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classes = selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)?.length ?? 0;
  const stripped = selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?/g, ' ');
  const elements = stripped.match(/(^|[\s>+~])(?:[\w-]+\|)?[\w-]+/g)?.length ?? 0;
  return ids * 10_000 + classes * 100 + elements;
}

function matches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

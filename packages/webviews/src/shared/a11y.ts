// Accessibility audit for the browser tests (spec M9.2): runs axe-core on a rendered view and
// lists the WCAG 2.1 A/AA violations. Used by *.web.test.ts only; not part of any bundle.
import axe from 'axe-core';

export async function accessibilityViolations(
  root: Element,
  options: { allow?: readonly string[] } = {},
): Promise<string[]> {
  const rules: Record<string, { enabled: boolean }> = {
    // colors come from the VS Code theme variables, which the test page does not define
    'color-contrast': { enabled: false },
  };
  for (const id of options.allow ?? []) rules[id] = { enabled: false };
  const result = await axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules,
  });
  return result.violations.map(
    (v) =>
      `${v.id}: ${v.help} (${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(', ')})`,
  );
}

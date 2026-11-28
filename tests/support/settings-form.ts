/**
 * What a browser would submit from the researcher's protocol form as the page shows it: hidden fields, checked radios and
 * boxes, text fields, and the chosen (or first) option of each select. Reading the page keeps a test from restating a value
 * the page itself decides, such as a preselected choice.
 */
export function submittedFrom(html: string): URLSearchParams {
  const body = html.match(/<form method="post" action="\/admin\/reception-settings\/protocol">([\s\S]*?)<\/form>/u)?.[1] ?? '';
  const entries: [string, string][] = [];
  for (const [tag] of body.matchAll(/<input\b[^>]*>/gu)) {
    const attribute = (name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'u'))?.[1];
    const type = attribute('type'), name = attribute('name');
    if (!name) continue;
    if (type === 'hidden' || (type === 'radio' || type === 'checkbox') && /\schecked[\s>]/u.test(tag)) entries.push([name, attribute('value') ?? 'on']);
    else if (type === 'text') entries.push([name, attribute('value') ?? '']);
  }
  for (const [, name, options] of body.matchAll(/<select name="([^"]+)">([\s\S]*?)<\/select>/gu)) {
    const chosen = options.match(/<option value="([^"]*)" selected>/u)?.[1] ?? options.match(/<option value="([^"]*)">/u)?.[1];
    if (chosen !== undefined) entries.push([name, chosen]);
  }
  return new URLSearchParams(entries);
}
export const checkedValues = (html: string, name: string): string[] => submittedFrom(html).getAll(name);

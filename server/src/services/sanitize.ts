// Plain-text / markdown-lite sanitizing for user-supplied text. Output is stored and returned as text only;
// clients must render it as text (or a markdown subset) and never as raw HTML.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
const HTML_TAG = /<\/?[a-zA-Z!][^>]*>/g;

/** Normalizes newlines, strips control/bidi characters and HTML tags, trims and length-limits. */
export function cleanText(input: string, max: number): string {
  return input.replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(HTML_TAG, '').trim().slice(0, max);
}

/** Single-line variant: newlines and tabs collapse to spaces. */
export function cleanLine(input: string, max: number): string {
  return cleanText(input, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);
}

export const MAX_NOTES = 20_000;

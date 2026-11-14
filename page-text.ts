export const EMPTY_PAGE_MESSAGE = "(page returned no readable text)";

function cutAtCharBoundary(text: string, maxChars: number): string {
  const sliced = text.slice(0, maxChars);
  if (!sliced) return sliced;
  const last = sliced.charCodeAt(sliced.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return sliced.slice(0, -1);
  if (last >= 0xdc00 && last <= 0xdfff) {
    const prev = sliced.length >= 2 ? sliced.charCodeAt(sliced.length - 2) : 0;
    if (prev < 0xd800 || prev > 0xdbff) return sliced.slice(0, -1);
  }
  return sliced;
}

export function truncatePageText(text: string, maxChars?: number): string {
  if (!text) return EMPTY_PAGE_MESSAGE;
  if (typeof maxChars === "number" && maxChars > 0 && text.length > maxChars) {
    return (
      cutAtCharBoundary(text.trimEnd(), maxChars) +
      `\n\n... (truncated, ${text.length} chars total)`
    );
  }
  return text;
}

export const EMPTY_PAGE_MESSAGE = "(page returned no readable text)";

export function pageText(text: string): string {
  return text || EMPTY_PAGE_MESSAGE;
}

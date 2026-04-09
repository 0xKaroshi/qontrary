/**
 * Parse a JSON object out of a model response.
 *
 * Strategy, in order:
 *   1. Try `JSON.parse(text)` directly — most well-behaved responses.
 *   2. If that fails, look for the OUTERMOST ```...``` fence (greedy match,
 *      so a fenced block whose content itself contains backticks survives)
 *      and parse the contents.
 *   3. If still no luck, slice from the first `{` to the last `}` and parse
 *      that.
 *
 * Throws an Error with the original parse failure if every strategy fails.
 *
 * @param text raw text from a model response
 */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (rawErr) {
    // "Unexpected non-whitespace character after JSON at position N" — the
    // model emitted a valid JSON object followed by trailing text. Truncate
    // and retry.
    const posMatch = (rawErr as Error).message.match(/position (\d+)/);
    if (posMatch) {
      try {
        return JSON.parse(text.slice(0, Number(posMatch[1])));
      } catch {
        /* fall through */
      }
    }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        /* fall through */
      }
    }
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        /* fall through */
      }
    }
    throw rawErr;
  }
}

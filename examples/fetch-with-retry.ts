// ---------------------------------------------------------------------------
// Real code: fetch a URL, and try again on an error answer or a failed
// connection, up to `retries` more times. The `fetch` to use is an argument.
//
// There is no pause between attempts and no timeout on one, on purpose: both
// need a clock, and a clock is the host's business, which the test of this
// function does not have yet. See fetch-with-retry.test.ts.
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** How many times to try again after the first attempt. Default 3. */
  retries?: number;
}

export async function fetchWithRetry(
  fetch: typeof globalThis.fetch,
  url: string,
  { retries = 3 }: RetryOptions = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok || attempt === retries) return response;
    } catch (error) {
      if (attempt === retries) throw error;
    }
  }
}

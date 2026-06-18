import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import type { EndpointDefaults } from "@octokit/types";

/**
 * Hardened Octokit constructor shared by every GitHub caller in the service.
 *
 * - `plugin-throttling` honors GitHub's primary and secondary rate limits and
 *   retries a bounded number of times instead of hammering the API (which is how
 *   secondary limits get tripped in the first place).
 * - `plugin-retry` retries transient network/5xx failures.
 * - A per-request timeout (see {@link createGithubClient}) guarantees a single
 *   slow GitHub response can never hang a caller (e.g. the monitor loop)
 *   indefinitely.
 */
const HardenedOctokit = Octokit.plugin(throttling, retry);

// A single GitHub request should never block a caller for long. 15s is generous
// for a healthy API call while bounding the worst case for a hung connection.
const REQUEST_TIMEOUT_MS = 15_000;

// Bounded automatic retries for rate-limit responses. Anything beyond this is a
// sign GitHub is genuinely unavailable, so we give up rather than pile on.
const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * `fetch` wrapper that aborts a request after {@link REQUEST_TIMEOUT_MS}. When
 * Octokit (or a plugin) already supplies a signal, the two are combined so either
 * can abort the request.
 */
function timeoutFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(input, { ...init, signal });
}

// Shared signature for both throttle callbacks. `@octokit/core`'s OctokitOptions
// types the `throttle` option as `any`, so the handler params are annotated
// explicitly to satisfy noImplicitAny. Returning `true` tells the plugin to retry.
type RateLimitHandler = (
  retryAfter: number,
  options: Required<EndpointDefaults>,
  octokit: Octokit,
  retryCount: number
) => boolean;

const onRateLimit: RateLimitHandler = (retryAfter, options, octokit, retryCount) => {
  octokit.log.warn(
    `[github] Primary rate limit on ${options.method} ${options.url}; ` +
      `retryAfter=${retryAfter}s (attempt ${retryCount})`
  );
  return retryCount < MAX_RATE_LIMIT_RETRIES;
};

const onSecondaryRateLimit: RateLimitHandler = (
  retryAfter,
  options,
  octokit,
  retryCount
) => {
  octokit.log.warn(
    `[github] Secondary rate limit on ${options.method} ${options.url}; ` +
      `retryAfter=${retryAfter}s (attempt ${retryCount})`
  );
  return retryCount < MAX_RATE_LIMIT_RETRIES;
};

/**
 * Create a rate-limit-aware, retrying, timeout-bounded Octokit client.
 * Use this everywhere instead of constructing `new Octokit(...)` directly.
 */
export function createGithubClient(auth: string): Octokit {
  return new HardenedOctokit({
    auth,
    request: { fetch: timeoutFetch },
    throttle: { onRateLimit, onSecondaryRateLimit },
  });
}

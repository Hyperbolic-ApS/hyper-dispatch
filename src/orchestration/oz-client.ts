import OzAPI from "oz-agent-sdk";

// Bounded by the number of distinct oz_api_key values across active projects.
const ozClientsByApiKey = new Map<string, OzAPI>();

export function getOzClient(apiKey: string): OzAPI {
  const existing = ozClientsByApiKey.get(apiKey);
  if (existing) {
    return existing;
  }
  const client = new OzAPI({ apiKey });
  ozClientsByApiKey.set(apiKey, client);
  return client;
}

import type { ParsedFinding } from "../db/queries.js";

// NOTE: MARKER uses the `g` flag so matchAll works, but we never call
// MARKER.test() — doing so would advance lastIndex and leak state across loop
// iterations.  Instead we derive the "has marker" decision from whether
// matchAll yielded any results (see hasMarker below).
const MARKER =
  /<!--\s*finding\s+key="([^"]+)"\s+severity="([^"]+)"\s+path="([^"]+)"\s*-->\s*\n?\s*(.*)/gi;
const LEGACY = /\[(REV-\d+)\]\s*(.*)/gi;

export function parseFindings(texts: string[]): ParsedFinding[] {
  const out = new Map<string, ParsedFinding>();
  for (const text of texts) {
    if (!text) continue;

    const markerMatches = [...text.matchAll(MARKER)];
    const hasMarker = markerMatches.length > 0;

    for (const m of markerMatches) {
      out.set(m[1]!, {
        key: m[1]!,
        severity: m[2],
        title: (m[4] ?? "").trim(),
        path: m[3]!,
      });
    }

    if (!hasMarker) {
      for (const m of text.matchAll(LEGACY)) {
        const key = m[1]!;
        if (!out.has(key)) {
          out.set(key, { key, title: (m[2] ?? "").trim(), path: "" });
        }
      }
    }
  }
  return [...out.values()];
}

export function actionableFindings(f: ParsedFinding[]): ParsedFinding[] {
  return f.filter(
    (x) => x.severity === undefined || /^(major|blocking)$/i.test(x.severity),
  );
}

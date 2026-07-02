import type { Capture } from '../capture.js';
import type { StreamManifestEntry } from '../manifest.js';
import { STREAM_IDS, STREAM_STATUSES } from '../registry.js';
import { STREAM_SCHEMA_VERSIONS } from '../version.js';

/**
 * Cross-check a capture's manifest against its stream payloads. The manifest is the source of truth
 * for "what was collected and why"; a stream marked `present` must carry data, and a stream with any
 * other status (`unsupported` / `not-requested` / `dropped` / `policy-blocked`) must NOT — otherwise
 * the "unknown != zero" contract is silently broken (e.g. `profile: present` with no profile block,
 * or data attached to a stream the manifest says was `dropped`).
 *
 * The codec round-trips whatever it is handed without judging it (pack must stay cheap on the page),
 * so this check is intentionally SEPARATE: use it in tests, in tooling that ingests captures, and as
 * a development guard — never on the hot pack path. Returns a list of human-readable problems; an
 * empty array means the manifest and payloads agree.
 */
export function checkConsistency(capture: Capture): string[] {
  const issues: string[] = [];
  for (const id of STREAM_IDS) {
    // The manifest is typed total, but this checker exists precisely for captures that broke the rules
    // (hand-built in JS, or mis-decoded) — so a missing record is an ISSUE to report, not a crash.
    const entry = capture.manifest.streams[id] as StreamManifestEntry | undefined;
    const hasData = capture.streams[id] !== undefined;
    if (entry === undefined) {
      issues.push(`stream "${id}" has no manifest record — the manifest must be total`);
      continue;
    }
    const status = entry.status;
    if (!(STREAM_STATUSES as readonly string[]).includes(status)) {
      // A newer writer may define statuses this build doesn't know; surface it rather than guessing.
      issues.push(`stream "${id}" has unknown manifest status "${status}" (a newer writer?)`);
    }
    if (status === 'present' && !hasData) {
      if (entry.schemaVersion > STREAM_SCHEMA_VERSIONS[id]) {
        // Not an inconsistency in the FILE — a version skew in the READER: the payload was written
        // with a newer per-stream schema than this build parses, so unpack skipped it by design.
        issues.push(
          `stream "${id}" was skipped on decode: written with schema v${entry.schemaVersion}, this build reads v${STREAM_SCHEMA_VERSIONS[id]}`,
        );
      } else {
        issues.push(`stream "${id}" is manifest-present but carries no data`);
      }
    } else if (status !== 'present' && hasData) {
      issues.push(`stream "${id}" carries data but its manifest status is "${status}" (expected "present")`);
    }
  }
  return issues;
}

/**
 * A JSON-serializable value. Used for app-provided payloads (User Timing `detail`, custom-event
 * `details`, capture `metadata`). Values already in this set round-trip losslessly.
 *
 * Anything outside it is normalized at pack time with **`JSON.stringify` semantics** (the documented
 * contract — see `encodeJson` and FileFormat.md): `toJSON()` is honored (a `Date` becomes its ISO
 * string), `undefined`/function/symbol object properties are dropped, those values become `null` in
 * arrays, and non-finite numbers become `null`. The one deviation from `JSON.stringify` (which throws):
 * `bigint` encodes as `null`. Normalization is total — no runtime value can make `pack()` throw.
 * Size and redaction budgets also apply to `detail`.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A JSON-serializable value. Used for app-provided `detail` payloads (User Timing) so the format
 * can promise lossless pack/unpack: anything outside this set (functions, DOM nodes, cyclic refs,
 * BigInt, undefined) is not representable and is dropped at pack time with a LossNote — never
 * silently mangled. Size and redaction budgets also apply to `detail`.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

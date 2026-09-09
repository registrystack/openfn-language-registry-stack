// SPDX-License-Identifier: Apache-2.0
// OpenFn expressions run in a VM realm. Normalize plain JSON into the SDK's
// realm while retaining its bounded, accessor-free input contract.
const { types: { isProxy } } = require("node:util");
const { breg } = require("@registrystack/client");
const { BaseRegistryClientError } = breg;
function copy(value, kind = "invalid_request") {
  const active = new Set();
  let nodes = 0;
  let bytes = 0;
  const invalid = () => { throw new BaseRegistryClientError({ kind, message: "Base Registry input is invalid" }); };
  const string = text => { bytes += Buffer.byteLength(text); if (bytes > 4 * 1024 * 1024) invalid(); return text; };
  function visit(item, depth) {
    if (++nodes > 100000 || depth > 128) invalid();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") return string(item);
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || isProxy(item) || active.has(item)) invalid();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    // Intrinsic Object.prototype has a null parent in each realm. Arrays
    // additionally have one Array.prototype layer. Custom classes are refused.
    if (array) {
      if (!prototype || Object.getOwnPropertyDescriptor(prototype, "constructor")?.value?.name !== "Array"
        || Object.getPrototypeOf(Object.getPrototypeOf(prototype)) !== null) invalid();
    } else if (prototype !== null && (Object.getPrototypeOf(prototype) !== null
      || Object.getOwnPropertyDescriptor(prototype, "constructor")?.value?.name !== "Object")) invalid();
    active.add(item);
    const result = array ? [] : {};
    let count = 0;
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== "string") invalid();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
      if (array && key === "length") continue;
      if (!descriptor.enumerable) invalid();
      string(key);
      if (array && (!Number.isSafeInteger(Number(key)) || Number(key) < 0 || String(Number(key)) !== key || Number(key) >= item.length)) invalid();
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      count++;
    }
    if (array && count !== item.length) invalid();
    active.delete(item);
    return result;
  }
  return visit(value, 0);
}
class BaseRegistryClient extends breg.BaseRegistryClient {
  constructor(config) { super(copy(config, "configuration")); }
}
for (const [method, indexes] of [
  ["getRecord", [2]], ["listRecords", [1]], ["continueList", [0]],
  ["lookupRecord", [2, 3]], ["createRecord", [1]], ["patchRecord", [3]], ["lifecycleActions", [1]],
]) {
  BaseRegistryClient.prototype[method] = function (...args) {
    for (const index of indexes) if (args[index] !== undefined) args[index] = copy(args[index]);
    return breg.BaseRegistryClient.prototype[method].apply(this, args);
  };
}
module.exports = { BaseRegistryClient, BaseRegistryClientError };

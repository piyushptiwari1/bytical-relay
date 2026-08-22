import { getRandomValues } from "expo-crypto";

// uuid + @noble crypto need WebCrypto RNG; Hermes lacks it natively
const g = globalThis as { crypto?: { getRandomValues?: typeof getRandomValues } };
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) g.crypto.getRandomValues = getRandomValues;

// Hermes ships TextEncoder; TextDecoder can lag — polyfill only when absent
if (
  typeof globalThis.TextDecoder === "undefined" ||
  typeof globalThis.TextEncoder === "undefined"
) {
  require("fast-text-encoding");
}

/**
 * Central env access (ADLM pattern) — read import.meta.env ONCE here,
 * never inline elsewhere. Empty API_BASE in dev = same-origin via Vite proxy.
 */
const RAW_BASE = import.meta.env.VITE_API_BASE || "";
export const API_BASE = RAW_BASE.replace(/\/+$/, "");
export const IS_PROD = import.meta.env.PROD;

/**
 * The contract, imported rather than copied.
 *
 * `src/api/contracts/**` is plain zod and plain TypeScript — no Nest, no drizzle, no node builtins —
 * so the browser can compile the same files the controllers validate against. That is the whole
 * point of group 0: the server and nine client screens read one definition, and a DTO cannot drift
 * between them because there is nothing to drift from.
 *
 * Every other module imports the contract through this file, so if the shared build ever has to
 * become a generated copy, one path changes instead of forty.
 */
export * from "../../../src/api/contracts/index.js";

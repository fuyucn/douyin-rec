/**
 * @drec/bilibili-api — Bilibili HTTP helpers that are not a transport target.
 *
 * Holds the login-file helpers (account key / Cookie header / CSRF) and the season-association
 * calls. Leaf package (rank 0.1): it depends on no other workspace package, so both the upload
 * targets (rank 0.5) and the zero-disk pump (rank 0.35) can use it without inverting the layering
 * that test/arch/layering.test.ts guards.
 */
export * from "./credential.js";
export * from "./season.js";
export * from "./season-resolve.js";


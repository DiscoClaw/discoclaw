// Local ESM entry for @discord/embedded-app-sdk.
// build.mjs bundles this into a single self-contained file so the canvas
// server can serve one request instead of proxying dozens of sub-imports
// that the Discord Activity proxy blocks.
export * from '@discord/embedded-app-sdk';

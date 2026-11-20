// Entry for the vendor build (`bun run build`, see vendor/README.md): every temper-design
// module the plugin imports, bundled to temper-design.mjs beside this file. Pure modules only —
// anything that reaches for a DOM (`sanitize`, and whatever imports it) cannot load in the
// worker or a components panel (the rail spike's Caution A), so this entry names the rail's
// ruled imports and no more (`WAYS_IN` and its bound and order, the handoff's own label and
// parser, the omission sentences).
export { WAYS_IN, WAY_IN_BOUND, WAY_IN_ORDER } from '@tasker-systems/temper-design/ways-in'
export { HANDOFF_LABEL, nextSection } from '@tasker-systems/temper-design/handoff'
export { omissionSentence } from '@tasker-systems/temper-design/omission'

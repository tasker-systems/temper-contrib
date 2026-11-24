// Types for the bundled vendor/temper-design.mjs: exactly what temper-design.entry.mjs
// exports. The bundle is built FROM that package (see README.md here), so the two cannot
// disagree in a way that compiles: tsc reads these declarations from node_modules while Orca
// runs the bundle.
export { WAYS_IN, WAY_IN_BOUND, WAY_IN_ORDER } from '@tasker-systems/temper-design/ways-in'
export type { WayIn, WayInFilter } from '@tasker-systems/temper-design/ways-in'
export { HANDOFF_LABEL, nextSection } from '@tasker-systems/temper-design/handoff'
export type { NextSection } from '@tasker-systems/temper-design/handoff'
export { drawnSentence, omissionSentence, uncountedSentence } from '@tasker-systems/temper-design/omission'
export { CORE_BINDINGS } from '@tasker-systems/temper-design/vocabulary'
export type { DocTypeBinding } from '@tasker-systems/temper-design/vocabulary'

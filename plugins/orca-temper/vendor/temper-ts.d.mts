// Types for the bundled vendor/temper-ts.mjs: exactly what the npm package exports. The bundle
// is built FROM that package (see README.md here), so the two cannot disagree in a way that
// compiles: tsc reads these declarations from node_modules while Orca runs the bundle.
export * from '@tasker-systems/temper-ts'

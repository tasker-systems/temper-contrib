// Entry for the custom editor's vendor bundle (`bun run build`, see vendor/README.md): what the
// editor's frame needs to render a body the way temper-ui does, for the frame only.
//
//   - the one parse (`prepareMarkdown`) and the one sanitizer pass (`sanitizeMarkdownHtml`). The
//     sanitizer needs a DOM (DOMPurify at module init: the rail spike's Caution A), which the
//     frame has and the worker and the components panel do not, so nothing outside `editor/`
//     imports this bundle;
//   - the contract's stylesheets as text — `base.css` (with the `.hljs` token colours) and the
//     `.md-body` recipe — and the house themes' role values, with the theme index that pairs each
//     with its counterpart, so the frame paints with the package's roles in Orca's light or dark.
export { prepareMarkdown } from '@tasker-systems/temper-design/markdown'
export { sanitizeMarkdownHtml } from '@tasker-systems/temper-design/sanitize'
export { default as BASE_CSS } from '@tasker-systems/temper-design/contract/base.css'
export { default as MARKDOWN_CSS } from '@tasker-systems/temper-design/contract/markdown.css'
export { default as DARK_THEME_CSS } from '@tasker-systems/temper-design/quiet-instrument/theme.css'
export { default as LIGHT_THEME_CSS } from '@tasker-systems/temper-design/quiet-instrument-paper/theme.css'
export { default as THEMES } from '@tasker-systems/temper-design/themes.json'

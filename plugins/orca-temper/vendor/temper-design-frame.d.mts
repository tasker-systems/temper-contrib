// Types for the bundled vendor/temper-design-frame.mjs: exactly what temper-design-frame.entry.mjs
// exports. The functions' types are read from the package itself while Orca runs the bundle (as
// temper-design.d.mts); the stylesheets are their text, and the theme index its rows.
export { prepareMarkdown } from '@tasker-systems/temper-design/markdown'
export { sanitizeMarkdownHtml } from '@tasker-systems/temper-design/sanitize'
export type { BodyLinks } from '@tasker-systems/temper-design/sanitize'
export declare const BASE_CSS: string
export declare const MARKDOWN_CSS: string
export declare const DARK_THEME_CSS: string
export declare const LIGHT_THEME_CSS: string
export declare const THEMES: readonly {
  name: string
  title: string
  appearance: 'light' | 'dark'
  counterpart: string
}[]

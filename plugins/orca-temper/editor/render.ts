// The default view's body: the working text rendered the way temper-ui renders a body — temper-
// design's one parse (`prepareMarkdown`, bounded and total) and its one sanitizer pass, never
// one without the other. The sanitizer needs a DOM, so this module is the frame's alone (the
// worker and the rail never import it). Vault links (`./<uuid>`) render as the sanitizer leaves
// them with no answers in hand: unchecked, never resolved by a guess.
import { prepareMarkdown, sanitizeMarkdownHtml } from '../vendor/temper-design-frame.mjs'

/**
 * Sanitized HTML for a body, for the `.md-body` wrapper the frame draws it in, with every
 * `<style>` element removed — HTML and SVG alike. The sanitizer drops `style` attributes but
 * admits `<style>` elements, and a record's own CSS must not restyle its body or anything
 * beside it; the frame also renders the body in its own shadow root (`view.ts`).
 */
export function renderBody(markdown: string): string {
  const holder = document.createElement('template')
  holder.innerHTML = sanitizeMarkdownHtml(prepareMarkdown(markdown))
  // A type selector matches `style` in every namespace, so this takes SVG's too.
  for (const style of Array.from(holder.content.querySelectorAll('style'))) {
    style.remove()
  }
  return holder.innerHTML
}

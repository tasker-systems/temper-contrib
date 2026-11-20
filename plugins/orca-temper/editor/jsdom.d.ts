// The one jsdom surface the render test uses: a window to stand in for the frame's, so the
// sanitizer (which needs a DOM) runs under `orca plugin test`. jsdom is a dev dependency only.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string)
    readonly window: Window & typeof globalThis
  }
}

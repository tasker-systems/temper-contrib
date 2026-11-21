// Hand a refused save to an agent: the desktop's refused-save handoff prompt (vendored byte for
// byte from apps/desktop — see vendor/README.md), with the person's intent and the three
// versions, then one paragraph for where the agent is: an Orca workspace holding the view file.
// The agent writes its reconciliation into that file, so it lands in the view's difference; it
// never writes to temper itself — the person reviews it and presses Save.
import { handoffPrompt } from '../vendor/desktop-handoff'
import type { StaleVersions } from '../src/editor-room/protocol'

export function viewHandoffPrompt(intent: string, versions: StaleVersions, title: string, viewPath: string): string {
  const prompt = handoffPrompt(
    { freeText: intent, oneClick: null },
    { title, base: versions.base, draft: versions.mine, newer: versions.current },
    ''
  )
  return [
    prompt,
    '',
    `In this Orca workspace my draft is the view file \`${viewPath}\`. Also write your proposed body into that file in place of its body, leaving its frontmatter (the lines between the opening \`---\` fences) exactly as it is, so I see your proposal in the view's difference. Do not write it to temper yourself: I review it there and press Save.`
  ].join('\n')
}

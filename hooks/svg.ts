import type { DagNode } from '../types'

import { STATUS_MARK, formatDuration } from './layout'
import type { Layout } from './layout'

export const escapeXml = (text: string): string =>
  text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)

const CHAR_W = 7.3

const fit = (text: string, width: number): string => {
  const room = Math.max(4, Math.floor((width - 16) / CHAR_W))
  return text.length > room ? `${text.slice(0, room - 1)}…` : text
}

const KIND_ICON: Record<DagNode['kind'], string> = {
  turn: '▶',
  step: '◆',
  reasoning: '¶',
  tool: '⚙',
  subagent: '⧉',
}

const STYLE = `
.bg{fill:#ffffff}
.b{stroke-width:1.2;rx:5}
.t{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;fill:#1f2328}
.d{fill:#6e7781}
.e{fill:none;stroke:#8c959f;stroke-width:1.2}
.e.spawns{stroke-dasharray:4 3;stroke:#8250df}
.turn{fill:#ddf4ff;stroke:#54aeff}
.step{fill:#f6f8fa;stroke:#afb8c1}
.reasoning{fill:#fff8c5;stroke:#d4a72c}
.tool{fill:#ffffff;stroke:#afb8c1}
.subagent{fill:#fbefff;stroke:#c297ff}
.running{stroke:#0969da;stroke-width:2}
.error{stroke:#cf222e;stroke-width:2}
.denied{stroke:#9a6700;stroke-dasharray:3 2}
.m-ok{fill:#1a7f37}.m-error{fill:#cf222e}.m-running{fill:#0969da}.m-denied{fill:#9a6700}
@media (prefers-color-scheme:dark){
.bg{fill:#0d1117}
.t{fill:#e6edf3}.d{fill:#8d96a0}.e{stroke:#6e7681}
.turn{fill:#0c2d6b;stroke:#388bfd}.step{fill:#161b22;stroke:#30363d}
.reasoning{fill:#2e2a0e;stroke:#9e6a03}.tool{fill:#0d1117;stroke:#30363d}
.subagent{fill:#271052;stroke:#8957e5}
.m-ok{fill:#3fb950}.m-error{fill:#f85149}.m-running{fill:#58a6ff}.m-denied{fill:#d29922}
}`

export type SvgOptions = { titles: boolean; background?: boolean }

/** The layout as one SVG document; with `titles`, each box carries its details as a tooltip. */
export const toSvg = (lay: Layout, opts: SvgOptions): string => {
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(lay.width)}" height="${Math.ceil(lay.height)}" viewBox="0 0 ${Math.ceil(lay.width)} ${Math.ceil(lay.height)}">`,
    `<style>${STYLE}</style>`,
  )
  if (opts.background) parts.push(`<rect class="bg" width="100%" height="100%"/>`)
  for (const l of lay.lines) parts.push(`<path class="e ${l.kind}" d="${l.d}"/>`)
  const boxes = lay.collapsed ? [lay.collapsed, ...lay.boxes] : lay.boxes
  for (const b of boxes) {
    const n = b.node
    const dur = formatDuration(n)
    const label = fit(`${KIND_ICON[n.kind]} ${n.label}`, b.w - (dur ? dur.length * CHAR_W + 22 : 18))
    parts.push(`<g>`)
    if (opts.titles && b.id !== 'collapsed') {
      const tip = [n.label, n.detail, n.result ? `→ ${n.result}` : '', dur].filter(Boolean).join('\n')
      parts.push(`<title>${escapeXml(tip)}</title>`)
    }
    parts.push(
      `<rect class="b ${n.kind}${n.status === 'ok' ? '' : ` ${n.status}`}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5"/>`,
      `<text class="t" x="${b.x + 8}" y="${b.y + 17}">${escapeXml(label)}</text>`,
    )
    if (b.id !== 'collapsed') {
      parts.push(`<text class="t m-${n.status}" x="${b.x + b.w - 8}" y="${b.y + 17}" text-anchor="end">${escapeXml(STATUS_MARK[n.status])}</text>`)
      if (dur) parts.push(`<text class="t d" x="${b.x + b.w - 20}" y="${b.y + 17}" text-anchor="end">${dur}</text>`)
    }
    parts.push(`</g>`)
  }
  parts.push(`</svg>`)
  return parts.join('')
}

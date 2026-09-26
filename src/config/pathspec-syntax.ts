import type { PhysicalPath } from './PathspecEvaluator.ts'

export type PathspecStatement = readonly [left: string, right?: string]

export namespace PathspecStatement {
  export function parse(line: string): PathspecStatement {
    const parts: string[] = []
    let start = 0
    let quoted = false
    for (let index = 0; index < line.length; index++) {
      if (line[index] === '"') quoted = !quoted
      if (quoted) continue
      if (line[index] === '#' && line[index + 1] === ' ') {
        line = line.slice(0, index)
        break
      }
      if (line[index] === '=') {
        parts.push(line.slice(start, index).trim())
        start = index + 1
      }
    }
    if (quoted) throw new Error('unterminated quoted path')
    parts.push(line.slice(start).trim())
    if (parts.length > 2) throw new Error('expected at most one assignment')
    return parts.length === 1 ? [parts[0]!] : [parts[0]!, parts[1]!]
  }

  export function value(text: string): string {
    if (!text) throw new Error('expected a path')
    if (text.startsWith('"') && text.endsWith('"') && !text.slice(1, -1).includes('"')) {
      const result = text.slice(1, -1)
      if (!result) throw new Error('expected a nonempty path')
      return result
    }
    if (text.includes('"')) throw new Error('quote the complete path')
    return text
  }
}

export interface RepositoryMount {
  readonly name: string
  readonly source: PhysicalPath
}

export namespace RepositoryMount {
  export function name(value: string): string {
    if (!value || /[<>:"/\\|?*+\0-\x1f]/.test(value) || /[. ]$/.test(value) ||
      value === '.' || value === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
      throw new Error('repository names must be portable folder names without +')
    }
    return value
  }
}

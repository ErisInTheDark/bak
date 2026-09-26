import type { Readable } from 'node:stream'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { PhysicalPath } from '../config/PathspecEvaluator.ts'
import { Metadata, nativePath, scanningIO } from './scanning-utils.ts'

export interface FileCapture {
  readonly source: PhysicalPath
  readonly metadata: Metadata
}

export namespace FileCapture {
  export async function read<T>(
    file: FileCapture, consume: (stream: Readable) => Promise<T>, signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted()
    const handle = await open(nativePath(file.source), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let stream: Readable | undefined
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || !Metadata.unchanged(file.metadata, Metadata.fromStats(before))) {
        throw new Error('file changed between discovery and capture')
      }
      stream = handle.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) })
      const result = await consume(stream)
      signal?.throwIfAborted()
      if (!stream.readableEnded) throw new Error('file consumer did not finish reading')
      const after = Metadata.fromStats(await handle.stat({ bigint: true }))
      const current = await scanningIO.inspect(file.source)
      if (!Metadata.unchanged(file.metadata, after) || !Metadata.unchanged(after, current.metadata)) {
        throw new Error('file changed during capture')
      }
      return result
    } finally {
      stream?.destroy()
      await handle.close()
    }
  }
}

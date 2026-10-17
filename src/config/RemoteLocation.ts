/** Where one backup folder stores remote data, configured by `@remote = <url>` in `.bakspec`. */
interface RemoteLocation {
  readonly backend: 'b2'
  readonly bucket: string
  /** Slash-separated key prefix without leading or trailing slashes; empty for the bucket root. */
  readonly prefix: string
}

namespace RemoteLocation {
  export function parse(url: string): RemoteLocation {
    const match = /^([a-z0-9]+):\/\/([^/]*)(?:\/(.*))?$/u.exec(url)
    if (!match) throw new Error('remote must look like b2://bucket[/prefix]')
    const [, scheme, bucket = '', path = ''] = match
    if (scheme !== 'b2') throw new Error(`unsupported remote ${scheme}://; only b2:// is supported`)
    if (!/^[A-Za-z0-9-]{6,63}$/u.test(bucket) || /^b2-/iu.test(bucket)) {
      throw new Error('b2 bucket names use 6-63 letters, digits or hyphens and cannot start with b2-')
    }
    const prefix = path.replace(/\/$/u, '')
    if (prefix && prefix.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[\\*?[\]{}]/u.test(segment))) {
      throw new Error('remote prefix segments must be nonempty literal names')
    }
    return { backend: 'b2', bucket, prefix }
  }

  export function format(location: RemoteLocation): string {
    return `${location.backend}://${location.bucket}${location.prefix ? `/${location.prefix}` : ''}`
  }
}

export default RemoteLocation

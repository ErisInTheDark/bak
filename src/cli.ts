import BakCli from './cli/BakCli.ts'

const controller = new AbortController()
const cancel = () => controller.abort(new Error('backup command cancelled'))
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
try {
  process.exitCode = await new BakCli().run(process.argv.slice(2), controller.signal)
} finally {
  process.removeListener('SIGINT', cancel)
  process.removeListener('SIGTERM', cancel)
}

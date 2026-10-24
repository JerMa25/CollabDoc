// Scheduled every 10 minutes: creates an automatic version of every document that changed
// since its last version, so writers can browse the history without thinking about it.
import { createVersion } from '../lib/versions'
import { scanAll } from '../lib/ddb'
import { TABLES } from '../lib/config'

export const handler = async () => {
  const docs = await scanAll({ TableName: TABLES.documents, ProjectionExpression: 'docId, rev, versionRev' })
  const changed = docs.filter((d) => Number(d.rev ?? 0) > Number(d.versionRev ?? 0))
  for (const d of changed) {
    try {
      await createVersion(d.docId, 'system', 'Version automatique')
    } catch (e) {
      console.error('snapshot failed', d.docId, e)
    }
  }
  console.log(JSON.stringify({ event: 'snapshots', scanned: docs.length, created: changed.length }))
}

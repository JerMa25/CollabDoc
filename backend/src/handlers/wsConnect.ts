// WebSocket $connect: wss://...?token=<session token>&docId=<doc>&cid=<Yjs client id>
// The socket is only used to RECEIVE edits and presence for one document.
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { getBlockedUntil } from '../lib/abuse'
import { isMember, writerFromToken } from '../lib/auth'
import { broadcast } from '../lib/broadcast'
import { TABLES, nowSec } from '../lib/config'
import { ddb } from '../lib/ddb'

type ConnectEvent = APIGatewayProxyWebsocketEventV2 & { queryStringParameters?: Record<string, string | undefined> }

export const handler = async (event: ConnectEvent) => {
  const q = event.queryStringParameters ?? {}
  const writer = await writerFromToken(q.token)
  if (!writer) return { statusCode: 401 }
  const docId = q.docId ?? ''
  if (!docId || !(await isMember(writer.email, docId))) return { statusCode: 403 }
  if (await getBlockedUntil(writer.email)) return { statusCode: 423 }

  const cid = Number(q.cid)
  await ddb.send(
    new PutCommand({
      TableName: TABLES.connections,
      Item: {
        connectionId: event.requestContext.connectionId,
        docId,
        email: writer.email,
        name: writer.name,
        cid: Number.isFinite(cid) ? cid : null,
        connectedAt: new Date().toISOString(),
        connectedAtSec: nowSec(),
        ttl: nowSec() + 3 * 3600, // API Gateway closes sockets after 2 h anyway
      },
    }),
  )
  // Ask the others to re-announce their presence so the newcomer sees them immediately.
  await broadcast(docId, { type: 'join', name: writer.name, email: writer.email }, event.requestContext.connectionId)
  return { statusCode: 200 }
}

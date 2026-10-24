// WebSocket $default: relays presence (Yjs "awareness": who is here, where their cursor is)
// to the other participants of the same document. Presence is ephemeral: nothing is stored.
// { "action": "awareness", "data": "<base64 awareness update>" } | { "action": "ping" }
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { broadcast } from '../lib/broadcast'
import { TABLES } from '../lib/config'
import { ddb } from '../lib/ddb'

const MAX_AWARENESS_BYTES = 8 * 1024

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  let msg: { action?: string; data?: string }
  try {
    msg = JSON.parse(event.body ?? '{}')
  } catch {
    return { statusCode: 400 }
  }
  if (msg.action !== 'awareness' || typeof msg.data !== 'string' || msg.data.length > MAX_AWARENESS_BYTES) return { statusCode: 200 }

  const connectionId = event.requestContext.connectionId
  const conn = (await ddb.send(new GetCommand({ TableName: TABLES.connections, Key: { connectionId } }))).Item
  if (!conn) return { statusCode: 410 }
  await broadcast(conn.docId, { type: 'awareness', data: msg.data }, connectionId)
  return { statusCode: 200 }
}

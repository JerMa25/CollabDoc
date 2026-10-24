// WebSocket $disconnect: forget the connection and tell the others this participant left.
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda'
import { DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { broadcast } from '../lib/broadcast'
import { TABLES } from '../lib/config'
import { ddb } from '../lib/ddb'

export const handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  const res = await ddb.send(
    new DeleteCommand({ TableName: TABLES.connections, Key: { connectionId: event.requestContext.connectionId }, ReturnValues: 'ALL_OLD' }),
  )
  const conn = res.Attributes
  if (conn?.docId) await broadcast(conn.docId, { type: 'leave', cid: conn.cid, name: conn.name })
  return { statusCode: 200 }
}

// Pushes a message to every WebSocket connected to a document, through the API Gateway
// management API. Connections that have disappeared (410 Gone) are cleaned up.
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'
import { DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { config, TABLES, nowSec } from './config'
import { ddb, isConditionFailure, queryAll } from './ddb'

let client: ApiGatewayManagementApiClient | undefined
const wsClient = () => (client ??= new ApiGatewayManagementApiClient({ endpoint: config.wsEndpoint }))

export async function connectionsOf(docId: string): Promise<string[]> {
  const items = await queryAll({
    TableName: TABLES.connections,
    IndexName: 'byDoc',
    KeyConditionExpression: 'docId = :d',
    ExpressionAttributeValues: { ':d': docId },
  })
  return items.map((i) => i.connectionId as string)
}

export async function broadcast(docId: string, message: object, exceptConnectionId?: string): Promise<void> {
  const data = JSON.stringify(message)
  const targets = (await connectionsOf(docId)).filter((id) => id !== exceptConnectionId)
  await Promise.all(targets.map((id) => send(id, data)))
}

async function send(connectionId: string, data: string): Promise<void> {
  try {
    await wsClient().send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }))
  } catch (e: any) {
    if (e?.name === 'GoneException' || e?.$metadata?.httpStatusCode === 410) {
      // "Gone" is also returned for a socket whose $connect is still in progress. Only forget
      // connections older than 30 s, otherwise a newcomer could be removed while connecting.
      await ddb
        .send(
          new DeleteCommand({
            TableName: TABLES.connections,
            Key: { connectionId },
            ConditionExpression: 'connectedAtSec < :cutoff',
            ExpressionAttributeValues: { ':cutoff': nowSec() - 30 },
          }),
        )
        .catch((err) => {
          if (!isConditionFailure(err)) throw err
        })
    } else {
      console.warn('postToConnection failed', connectionId, e?.name)
    }
  }
}

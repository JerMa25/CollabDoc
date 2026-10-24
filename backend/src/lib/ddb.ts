import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, type QueryCommandInput, type ScanCommandInput } from '@aws-sdk/lib-dynamodb'

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})

type Item = Record<string, any>

/** Query following pagination until every item is read. */
export async function queryAll(input: QueryCommandInput): Promise<Item[]> {
  const items: Item[] = []
  let ExclusiveStartKey: Item | undefined
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }))
    items.push(...(page.Items ?? []))
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return items
}

/** Scan following pagination (only used on small tables: admin view, snapshots). */
export async function scanAll(input: ScanCommandInput): Promise<Item[]> {
  const items: Item[] = []
  let ExclusiveStartKey: Item | undefined
  do {
    const page = await ddb.send(new ScanCommand({ ...input, ExclusiveStartKey }))
    items.push(...(page.Items ?? []))
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return items
}

/** True when a DynamoDB call failed because its ConditionExpression was false. */
export const isConditionFailure = (e: unknown) => (e as Error)?.name === 'ConditionalCheckFailedException'

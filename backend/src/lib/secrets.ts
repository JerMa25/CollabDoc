import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

const ssm = new SSMClient({})
const cache = new Map<string, string>()

/** Reads a SecureString from SSM Parameter Store, cached for the lifetime of the Lambda container. */
export async function getSecret(name: string): Promise<string> {
  const cached = cache.get(name)
  if (cached) return cached
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
  const value = res.Parameter?.Value
  if (!value) throw new Error(`Parameter ${name} is empty`)
  cache.set(name, value)
  return value
}

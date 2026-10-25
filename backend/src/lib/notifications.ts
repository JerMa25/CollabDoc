// "Last download" e-mails go through Amazon SNS, not SES.
// Why: without a domain of our own, SES has to send "from" a Gmail address; Gmail's anti-spoofing
// checks (DMARC) then send the message to spam or drop it, and in the SES sandbox only verified
// recipients are allowed. SNS sends from no-reply@sns.amazonaws.com to any address, once the
// recipient has confirmed its subscription (AWS anti-spam rule, one click, done once).
//
// One topic for the whole application; each link creator is subscribed with a filter policy on
// the `creator` message attribute, so they only receive the notifications of their own links.
import { ListSubscriptionsByTopicCommand, PublishCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns'
import { config } from './config'

const sns = new SNSClient({})

export type SubscriptionStatus = 'confirmed' | 'pending' | 'unavailable'

async function currentStatus(email: string): Promise<SubscriptionStatus | null> {
  let NextToken: string | undefined
  do {
    const page = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: config.notificationTopicArn, NextToken }))
    const sub = page.Subscriptions?.find((s) => s.Protocol === 'email' && s.Endpoint?.toLowerCase() === email)
    if (sub) return sub.SubscriptionArn?.startsWith('arn:') ? 'confirmed' : 'pending'
    NextToken = page.NextToken
  } while (NextToken)
  return null
}

/**
 * Makes sure `email` is subscribed. A new (or still unconfirmed) subscription makes AWS send the
 * confirmation e-mail. Never throws: a notification problem must not prevent creating a link.
 */
export async function ensureSubscribed(email: string): Promise<SubscriptionStatus> {
  try {
    if ((await currentStatus(email)) === 'confirmed') return 'confirmed'
    await sns.send(
      new SubscribeCommand({
        TopicArn: config.notificationTopicArn,
        Protocol: 'email',
        Endpoint: email,
        Attributes: { FilterPolicy: JSON.stringify({ creator: [email] }) },
      }),
    )
    return 'pending'
  } catch (e) {
    console.error('SNS subscription failed', email, e)
    return 'unavailable'
  }
}

export async function notifyCreator(creatorEmail: string, subject: string, message: string): Promise<void> {
  await sns.send(
    new PublishCommand({
      TopicArn: config.notificationTopicArn,
      Subject: subject.replace(/[\r\n]/g, ' ').slice(0, 99),
      Message: message,
      MessageAttributes: { creator: { DataType: 'String', StringValue: creatorEmail } },
    }),
  )
}

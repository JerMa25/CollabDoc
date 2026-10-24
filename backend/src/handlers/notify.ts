// Triggered by the DynamoDB stream of the Links table, filtered (in the template) on the
// transition remaining 1 -> 0: the last copy has just been taken. E-mails the link creator.
// Kept out of the download path: the claim function needs no e-mail permission, and an
// e-mail failure can never block a download.
import type { DynamoDBStreamEvent } from 'aws-lambda'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import { config } from '../lib/config'

const ses = new SESv2Client({})

export const handler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage
    if (!image) continue
    const link = unmarshall(image as any)
    const linkUrl = config.frontendUrl ? `${config.frontendUrl}/#/d/${link.linkId}` : link.linkId
    try {
      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: config.notificationSender,
          Destination: { ToAddresses: [link.creatorEmail] },
          Content: {
            Simple: {
              Subject: { Data: `[CollabDoc] Dernier téléchargement : « ${link.docTitle} »`, Charset: 'UTF-8' },
              Body: {
                Text: {
                  Charset: 'UTF-8',
                  Data:
                    `Bonjour ${link.creatorName ?? ''},\n\n` +
                    `Le lien de téléchargement du document « ${link.docTitle} » vient d'être utilisé pour la dernière fois ` +
                    `(${link.maxDownloads}/${link.maxDownloads} exemplaires distribués).\n\n` +
                    `Lien : ${linkUrl}\n\n— CollabDoc`,
                },
              },
            },
          },
        }),
      )
      console.log(JSON.stringify({ event: 'last_download_email_sent', linkId: link.linkId, to: link.creatorEmail }))
    } catch (e: any) {
      // In the SES sandbox, unverified recipients are rejected: log it, do not retry forever.
      if (e?.name === 'MessageRejected' || e?.name === 'BadRequestException') {
        console.error(JSON.stringify({ event: 'last_download_email_rejected', linkId: link.linkId, to: link.creatorEmail, reason: e.message }))
      } else {
        throw e // transient error: the stream retries the record
      }
    }
  }
}

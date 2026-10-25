// Triggered by the DynamoDB stream of the Links table, filtered (in the template) on the
// transition remaining 1 -> 0: the last copy has just been taken. E-mails the link creator
// through SNS (see lib/notifications.ts for why SNS rather than SES).
// Kept out of the download path: the claim function has no notification permission, and a
// notification failure can never block a download.
import type { DynamoDBStreamEvent } from 'aws-lambda'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import { config } from '../lib/config'
import { notifyCreator } from '../lib/notifications'

export const handler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage
    if (!image) continue
    const link = unmarshall(image as any)
    const linkUrl = config.frontendUrl ? `${config.frontendUrl}/#/d/${link.linkId}` : link.linkId
    await notifyCreator(
      link.creatorEmail,
      `[CollabDoc] Dernier téléchargement : ${link.docTitle}`,
      `Bonjour ${link.creatorName ?? ''},\n\n` +
        `Le lien de téléchargement du document « ${link.docTitle} » vient d'être utilisé pour la dernière fois ` +
        `(${link.maxDownloads}/${link.maxDownloads} exemplaires distribués).\n\n` +
        `Lien : ${linkUrl}\n\n— CollabDoc`,
    ) // an error here is thrown: the stream retries the record (up to 5 times)
    console.log(JSON.stringify({ event: 'last_download_notification_sent', linkId: link.linkId, to: link.creatorEmail }))
  }
}

// Central configuration. Values come from environment variables set by the SAM template,
// so no resource name (and no credential) is hard-coded in the code.

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

export const TABLES = {
  get documents() { return env('TABLE_DOCUMENTS') },
  get members() { return env('TABLE_MEMBERS') },
  get updates() { return env('TABLE_UPDATES') },
  get credits() { return env('TABLE_CREDITS') },
  get connections() { return env('TABLE_CONNECTIONS') },
  get links() { return env('TABLE_LINKS') },
  get claims() { return env('TABLE_CLAIMS') },
  get versions() { return env('TABLE_VERSIONS') },
  get abuse() { return env('TABLE_ABUSE') },
}

export const config = {
  get dataBucket() { return env('DATA_BUCKET') },
  get wsEndpoint() { return env('WS_ENDPOINT') },
  get sessionSecretParam() { return env('SESSION_SECRET_PARAM') },
  get adminTokenParam() { return env('ADMIN_TOKEN_PARAM') },
  get notificationSender() { return env('NOTIFICATION_SENDER') },
  get frontendUrl() { return process.env.FRONTEND_URL ?? '' },
}

/** Daily write credit per writer (characters). */
export const CREDIT_LIMIT = 10_000

/** Abuse detection: this many rejected writes within the window blocks the writer. */
export const ABUSE = { windowSec: 600, threshold: 20, blockSec: 900 }

/** Name of the Y.Text holding the document content (shared by client and server). */
export const TEXT_KEY = 'content'

/** Lifetime of a presigned PDF download URL. */
export const PDF_URL_TTL_SEC = 60

export const nowSec = () => Math.floor(Date.now() / 1000)

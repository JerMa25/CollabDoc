// Constraint 5 & 6 — the publication peak, with k6 (https://k6.io).
// 15 000 visitors open the link: 12 000 (80 %) during the first minute, the remaining
// 3 000 over the next 4 minutes. Each visitor behaves like the download page:
//   GET status (through CloudFront, cached) -> POST claim -> on 429/5xx wait (backoff) and retry
//   until it gets "ok" (download) or "exhausted".
// Measured: every visitor ends with an explicit answer (ok / exhausted), the number of "ok"
// never exceeds the link limit, and no request fails without an answer.
// Run writers.mjs at the same time for the "300 writers keep writing" part.
//
// Usage:
//   k6 run -e API_URL=https://xxx.execute-api.eu-north-1.amazonaws.com \
//          -e FRONT_URL=https://dxxxx.cloudfront.net -e LINK_ID=abc123 tests/load/spike.js
import http from 'k6/http'
import { sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'

const API = __ENV.API_URL
const FRONT = __ENV.FRONT_URL
const LINK = __ENV.LINK_ID

const outcomeOk = new Counter('outcome_download')
const outcomeExhausted = new Counter('outcome_exhausted')
const outcomeNoAnswer = new Counter('outcome_no_final_answer')
const waits = new Counter('told_to_wait') // 429/503 answers ("please wait")
const errors = new Counter('unexpected_responses') // anything that is not 200/410/429/503
const timeToAnswer = new Trend('time_to_final_answer', true)

export const options = {
  scenarios: {
    publication: {
      executor: 'ramping-arrival-rate',
      startRate: 200,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_VUS ?? 500),
      maxVUs: Number(__ENV.MAX_VUS ?? 3000),
      stages: [
        { target: 200, duration: '60s' }, // 12 000 visitors in the 1st minute
        { target: 12.5, duration: '1s' },
        { target: 12.5, duration: '239s' }, // 3 000 over the next 4 minutes
      ],
    },
  },
  thresholds: {
    unexpected_responses: ['count==0'],
    outcome_no_final_answer: ['count==0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(90)', 'p(99)', 'max'],
}

export default function () {
  const start = Date.now()
  http.get(`${FRONT}/public/links/${LINK}`, { tags: { name: 'status' } })
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = http.post(`${API}/links/${LINK}/claim`, null, { tags: { name: 'claim' } })
    if (res.status === 200) {
      outcomeOk.add(1)
      timeToAnswer.add(Date.now() - start)
      return
    }
    if (res.status === 410) {
      outcomeExhausted.add(1)
      timeToAnswer.add(Date.now() - start)
      return
    }
    if (res.status === 429 || res.status === 503) waits.add(1)
    else errors.add(1, { status: String(res.status) })
    sleep(Math.min(30, 2 ** Math.min(attempt, 5)) * (0.5 + Math.random() / 2))
  }
  outcomeNoAnswer.add(1)
}

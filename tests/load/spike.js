// Constraint 5 & 6 — the publication peak, with k6 (https://k6.io).
// 15 000 visitors open the link: 1 500 at the announcement second, 12 000 in total (80 %)
// during the first minute, the remaining 3 000 over the next 4 minutes. Each visitor behaves like the download page:
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
    // The announcement second: 1 500 visitors click at the very same instant
    // (more than the API burst limit, so some are told to wait and retry).
    announcement: {
      executor: 'per-vu-iterations',
      vus: Number(__ENV.BURST ?? 1500),
      iterations: 1,
      maxDuration: '5m',
    },
    // Then 10 500 more during the rest of the first minute (=> 12 000 = 80 % in 1 min),
    // and the remaining 3 000 over the next 4 minutes. Total: 15 000 visitors.
    publication: {
      executor: 'ramping-arrival-rate',
      startRate: 175,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_VUS ?? 1500),
      maxVUs: Number(__ENV.MAX_VUS ?? 8000),
      stages: [{ target: 175, duration: '60s' }],
    },
    tail: {
      executor: 'constant-arrival-rate',
      rate: 25,
      timeUnit: '2s', // 12.5 visitors/s for 4 minutes = 3 000
      duration: '240s',
      startTime: '60s',
      preAllocatedVUs: 100,
      maxVUs: 1000,
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

// Raw results: full k6 data as JSON (tests/results/spike-summary-<run>.json) + a short summary.
export function handleSummary(data) {
  const v = (name, field = 'count') => (data.metrics[name] ? data.metrics[name].values[field] : 0)
  const run = __ENV.RUN_ID || 'run'
  const lines = [
    `visitors (iterations)         : ${v('iterations')}`,
    `downloads (200)               : ${v('outcome_download')}`,
    `told "exhausted" (410)        : ${v('outcome_exhausted')}`,
    `told "please wait" (429/503)  : ${v('told_to_wait')}`,
    `unexpected responses          : ${v('unexpected_responses')}`,
    `visitors without final answer : ${v('outcome_no_final_answer')}`,
    `time to final answer p50/p90/p99/max (ms): ${Math.round(v('time_to_final_answer', 'p(50)'))} / ${Math.round(v('time_to_final_answer', 'p(90)'))} / ${Math.round(v('time_to_final_answer', 'p(99)'))} / ${Math.round(v('time_to_final_answer', 'max'))}`,
    `visitors NOT started by k6 (load generator saturated): ${v('dropped_iterations')}`,
    `http requests                 : ${v('http_reqs')}  (status >= 400, incl. expected 410/429: ${v('http_req_failed', 'passes')})`,
    `http_req_duration p50/p90/p99 (ms): ${Math.round(v('http_req_duration', 'p(50)'))} / ${Math.round(v('http_req_duration', 'p(90)'))} / ${Math.round(v('http_req_duration', 'p(99)'))}`,
  ]
  return {
    stdout: lines.join('\n') + '\n',
    [`results/spike-summary-${run}.json`]: JSON.stringify(data, null, 2),
  }
}

// Association dashboard (#/admin): open documents, active links, blocked writers. Refreshed every 5 s.
import { useEffect, useState, type FormEvent } from 'react'
import { api, colorFor } from '../api'
import { Avatar, Brand, Icon, relativeTime, ThemeToggle } from '../ui'

interface AdminState {
  generatedAt: string
  openDocuments: { docId: string; title: string; connections: number; users: { name: string; email: string }[] }[]
  activeLinks: { linkId: string; docTitle: string; creatorEmail: string; maxDownloads: number; remaining: number; createdAt: string }[]
  exhaustedLinks: { linkId: string; docTitle: string; maxDownloads: number }[]
  blockedWriters: { email: string; reason: string; strikes: number; blockedUntil: string }[]
}

const TOKEN_KEY = 'collabdoc.admin'
const REASONS: Record<string, string> = { credit_exhausted: 'Crédit dépassé', write_while_blocked: 'Insiste pendant le blocage' }

export function Admin() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '')
  const [input, setInput] = useState('')
  const [data, setData] = useState<AdminState | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!token) return
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        setData(await api<AdminState>('GET', '/admin/state', undefined, { 'x-admin-token': token }))
        setError('')
      } catch (e: any) {
        setError(e.message)
        if (e.status === 401) {
          sessionStorage.removeItem(TOKEN_KEY)
          setToken('')
          return
        }
      }
      timer = setTimeout(load, 5000)
    }
    void load()
    return () => clearTimeout(timer)
  }, [token])

  const login = (e: FormEvent) => {
    e.preventDefault()
    sessionStorage.setItem(TOKEN_KEY, input)
    setToken(input)
  }

  if (!token)
    return (
      <div className="public">
        <ThemeToggle floating />
        <form onSubmit={login} className="card">
          <Brand />
          <div className="icon-circle">
            <Icon name="shield" size={28} />
          </div>
          <h2>Espace association</h2>
          <p>État de l'application en temps réel.</p>
          <input type="password" placeholder="Jeton d'administration" value={input} onChange={(e) => setInput(e.target.value)} required style={{ width: '100%' }} />
          {error && <p className="error">{error}</p>}
          <button type="submit" className="big" style={{ width: '100%' }}>
            Entrer
          </button>
        </form>
      </div>
    )

  const online = data?.openDocuments.reduce((n, d) => n + d.connections, 0) ?? 0
  const remaining = data?.activeLinks.reduce((n, l) => n + Number(l.remaining), 0) ?? 0

  return (
    <>
      <header className="topbar">
        <Brand href="#/admin" />
        <span className="badge accent">Association</span>
        <span className="spacer" />
        {data && <span className="live">En direct · {new Date(data.generatedAt).toLocaleTimeString('fr-FR')}</span>}
        <ThemeToggle />
        <button
          className="ghost icon-only"
          title="Se déconnecter"
          onClick={() => {
            sessionStorage.removeItem(TOKEN_KEY)
            setToken('')
          }}
        >
          <Icon name="logout" />
        </button>
      </header>

      <main className="page wide">
        <h1>État de l'application</h1>
        {error && <p className="error">{error}</p>}
        {!data ? (
          <p className="muted">Chargement…</p>
        ) : (
          <>
            <div className="kpis">
              <Kpi icon="doc" value={data.openDocuments.length} label="documents ouverts" />
              <Kpi icon="users" value={online} label="rédacteurs connectés" kind="success" />
              <Kpi icon="link" value={data.activeLinks.length} label={`liens actifs · ${remaining.toLocaleString('fr-FR')} exemplaires restants`} />
              <Kpi icon="lock" value={data.blockedWriters.length} label="personnes bloquées" kind={data.blockedWriters.length ? 'danger' : undefined} />
            </div>

            <div className="panels">
              <section className="card">
                <h2 className="row" style={{ marginBottom: 10 }}>
                  <Icon name="doc" /> Documents ouverts
                </h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Document</th>
                        <th>Rédacteurs présents</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.openDocuments.length === 0 && (
                        <tr>
                          <td colSpan={2} className="muted">Aucun document ouvert.</td>
                        </tr>
                      )}
                      {data.openDocuments.map((d) => (
                        <tr key={d.docId}>
                          <td>{d.title}</td>
                          <td>
                            <div className="avatars">
                              {d.users.slice(0, 8).map((u, i) => (
                                <Avatar key={i} name={u.name} color={colorFor(u.email)} title={`${u.name} <${u.email}>`} />
                              ))}
                              {d.users.length > 8 && <span className="badge">+{d.users.length - 8}</span>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="card">
                <h2 className="row" style={{ marginBottom: 10 }}>
                  <Icon name="link" /> Liens actifs
                </h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Document</th>
                        <th>Restants</th>
                        <th>Créé par</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.activeLinks.length === 0 && (
                        <tr>
                          <td colSpan={3} className="muted">Aucun lien actif.</td>
                        </tr>
                      )}
                      {data.activeLinks.map((l) => (
                        <tr key={l.linkId}>
                          <td>
                            {l.docTitle}
                            <small style={{ display: 'block' }}>{relativeTime(l.createdAt)}</small>
                          </td>
                          <td style={{ minWidth: 120 }}>
                            <b>{l.remaining}</b> / {l.maxDownloads}
                            <div className="progress" style={{ marginTop: 4 }}>
                              <div style={{ width: `${(l.remaining / l.maxDownloads) * 100}%` }} />
                            </div>
                          </td>
                          <td>
                            <small>{l.creatorEmail}</small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <small>{data.exhaustedLinks.length} lien(s) épuisé(s)</small>
              </section>

              <section className="card">
                <h2 className="row" style={{ marginBottom: 10 }}>
                  <Icon name="lock" /> Personnes bloquées
                </h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>E-mail</th>
                        <th>Motif</th>
                        <th>Jusqu'à</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.blockedWriters.length === 0 && (
                        <tr>
                          <td colSpan={3} className="muted">Personne n'est bloqué.</td>
                        </tr>
                      )}
                      {data.blockedWriters.map((b) => (
                        <tr key={b.email}>
                          <td>{b.email}</td>
                          <td>
                            <span className="badge danger">{REASONS[b.reason] ?? b.reason}</span>
                            <small style={{ display: 'block' }}>{b.strikes} refus</small>
                          </td>
                          <td>{new Date(b.blockedUntil).toLocaleTimeString('fr-FR')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </>
        )}
      </main>
    </>
  )
}

function Kpi({ icon, value, label, kind }: { icon: string; value: number; label: string; kind?: 'success' | 'danger' }) {
  return (
    <div className="card kpi">
      <span className={`kpi-icon ${kind ?? ''}`}>
        <Icon name={icon} size={22} />
      </span>
      <div>
        <div className="value">{value.toLocaleString('fr-FR')}</div>
        <div className="label">{label}</div>
      </div>
    </div>
  )
}

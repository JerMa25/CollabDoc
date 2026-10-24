import { useEffect, useState, type FormEvent } from 'react'
import { api, colorFor, navigate, setSession, type Credit, type Session } from '../api'
import { Avatar, Brand, Icon, relativeTime, ThemeToggle } from '../ui'
import { CreditMeter } from './CreditMeter'

interface DocItem {
  docId: string
  title: string
  role: string
  addedAt: string
}

export function Documents({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [docs, setDocs] = useState<DocItem[] | null>(null)
  const [credit, setCredit] = useState<Credit | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const logout = () => {
    setSession(null)
    onLogout()
  }

  useEffect(() => {
    Promise.all([api<{ documents: DocItem[] }>('GET', '/documents'), api<{ credit: Credit }>('GET', '/me')])
      .then(([d, me]) => {
        setDocs(d.documents)
        setCredit(me.credit)
      })
      .catch((e) => (e.status === 401 ? logout() : setError(e.message)))
  }, [])

  const create = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const doc = await api<{ docId: string }>('POST', '/documents', { title })
      navigate(`/doc/${doc.docId}`)
    } catch (err: any) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <>
      <header className="topbar">
        <Brand />
        <span className="spacer" />
        {credit && <CreditMeter credit={credit} />}
        <div className="row" style={{ gap: 8 }}>
          <Avatar name={session.name} color={colorFor(session.email)} title={session.email} />
          <span style={{ fontSize: '.9rem' }}>{session.name}</span>
        </div>
        <ThemeToggle />
        <button className="ghost icon-only" onClick={logout} title="Changer d'identité">
          <Icon name="logout" />
        </button>
      </header>

      <main className="page">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <h1>Mes documents</h1>
            <small>Les documents que vous avez créés ou qui vous ont été partagés.</small>
          </div>
        </div>

        <form onSubmit={create} className="card create-bar">
          <input placeholder="Titre du nouveau document, ex. « Journal 2026 — Édito »" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
          <button type="submit" disabled={busy}>
            <Icon name="plus" /> Nouveau document
          </button>
        </form>
        {error && <p className="error">{error}</p>}

        <div className="section-title">
          <h2>Récents</h2>
          {docs && <span className="badge">{docs.length}</span>}
        </div>

        {docs === null ? (
          <p className="muted">Chargement…</p>
        ) : docs.length === 0 ? (
          <div className="card empty">
            <div className="icon-circle">
              <Icon name="doc" size={28} />
            </div>
            <h3>Aucun document pour l'instant</h3>
            <p>Créez-en un ci-dessus, ou demandez à un rédacteur de vous y donner accès avec votre e-mail.</p>
          </div>
        ) : (
          <div className="doc-grid">
            {docs.map((d) => (
              <a key={d.docId} href={`#/doc/${d.docId}`} className="card doc-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="doc-icon">
                    <Icon name="doc" />
                  </span>
                  <span className={`badge ${d.role === 'owner' ? 'accent' : ''}`}>{d.role === 'owner' ? 'Propriétaire' : 'Éditeur'}</span>
                </div>
                <h3>{d.title}</h3>
                <small>Ajouté {relativeTime(d.addedAt)}</small>
              </a>
            ))}
          </div>
        )}
      </main>
    </>
  )
}

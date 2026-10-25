import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { basicSetup } from 'codemirror'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { yCollab } from 'y-codemirror.next'
import { api, colorFor, type Credit, type Session } from '../api'
import { DocProvider } from '../provider'
import { Avatar, Icon, relativeTime, ThemeToggle, useToasts } from '../ui'
import { CreditMeter } from './CreditMeter'

interface DocInfo {
  docId: string
  title: string
  ownerEmail: string
  members: { email: string; role: string }[]
}
interface Presence {
  clientId: number
  name: string
  email: string
  color: string
  line?: number
  self: boolean
}
type Toast = ReturnType<typeof useToasts>['push']

const STATUS_LABEL = { connecting: 'Connexion…', online: 'En ligne', offline: 'Hors ligne — reconnexion…' }
const SAVE_LABEL = { saved: 'Tout est enregistré', saving: 'Enregistrement…', retrying: 'Nouvel essai…' }

export function Editor({ docId, session }: { docId: string; session: Session }) {
  const host = useRef<HTMLDivElement>(null)
  const creditRef = useRef<Credit | null>(null)
  const toast = useToasts()
  const [info, setInfo] = useState<DocInfo | null>(null)
  const [error, setError] = useState('')
  const [credit, setCreditState] = useState<Credit | null>(null)
  const [status, setStatus] = useState<keyof typeof STATUS_LABEL>('connecting')
  const [save, setSave] = useState<keyof typeof SAVE_LABEL>('saved')
  const [synced, setSynced] = useState(false)
  const [chars, setChars] = useState(0)
  const [presence, setPresence] = useState<Presence[]>([])
  const [epoch, setEpoch] = useState(0) // incremented to rebuild the editor from the server state
  const [tab, setTab] = useState<'share' | 'versions' | 'links'>('share')

  const setCredit = useCallback((c: Credit) => {
    creditRef.current = c
    setCreditState(c)
  }, [])

  const loadInfo = useCallback(async () => {
    try {
      const [doc, me] = await Promise.all([api<DocInfo>('GET', `/documents/${docId}`), api<{ credit: Credit; blockedUntil: string | null }>('GET', '/me')])
      setInfo(doc)
      setCredit(me.credit)
      if (me.blockedUntil) toast.push(`Vous êtes bloqué jusqu'à ${new Date(me.blockedUntil).toLocaleTimeString()} (trop de tentatives refusées).`, 'error')
    } catch (e: any) {
      setError(e.status === 403 ? "Vous n'avez pas accès à ce document. Demandez à un de ses rédacteurs de vous l'ouvrir avec votre e-mail." : e.message)
    }
  }, [docId, setCredit])
  useEffect(() => void loadInfo(), [loadInfo])

  useEffect(() => {
    if (!info || !host.current) return
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    const awareness = new Awareness(ydoc)
    const color = colorFor(session.email)
    awareness.setLocalStateField('user', { name: session.name, email: session.email, color, colorLight: color + '33' })

    const editable = new Compartment()
    // Client-side guard: refuse typing beyond the remaining credit (the server enforces it anyway).
    const creditGuard = EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || !tr.annotation(Transaction.userEvent)) return tr
      let inserted = 0
      tr.changes.iterChanges((_a, _b, _c, _d, text) => (inserted += text.length))
      const c = creditRef.current
      if (c && inserted > c.remaining) {
        toast.push(`Crédit insuffisant : il vous reste ${c.remaining} caractère(s) aujourd'hui.`, 'error')
        return []
      }
      if (c) creditRef.current = { ...c, remaining: c.remaining - inserted }
      return tr
    })

    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          yCollab(ytext, awareness),
          creditGuard,
          editable.of(EditorState.readOnly.of(true)),
          EditorView.updateListener.of((u) => u.docChanged && setChars(u.state.doc.length)),
        ],
      }),
    })

    const refreshPresence = () => {
      const list: Presence[] = []
      awareness.getStates().forEach((state: any, clientId) => {
        if (!state.user) return
        let line: number | undefined
        if (state.cursor?.head) {
          const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.head), ydoc)
          if (abs && abs.index <= view.state.doc.length) line = view.state.doc.lineAt(abs.index).number
        }
        list.push({ clientId, name: state.user.name, email: state.user.email, color: state.user.color, line, self: clientId === ydoc.clientID })
      })
      setPresence(list.sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name)))
    }
    awareness.on('change', refreshPresence)

    const provider = new DocProvider(docId, session.token, ydoc, awareness, {
      onStatus: setStatus,
      onSaveState: setSave,
      onSynced: () => {
        setSynced(true)
        setChars(view.state.doc.length)
        view.dispatch({ effects: editable.reconfigure(EditorState.readOnly.of(false)) })
        refreshPresence()
      },
      onAck: setCredit,
      onReject: (code, body) => {
        const messages: Record<string, string> = {
          CREDIT_EXHAUSTED: "Crédit d'écriture épuisé : vos dernières modifications n'ont pas été acceptées.",
          WRITER_BLOCKED: `Trop de tentatives refusées : vous êtes bloqué jusqu'à ${body?.blockedUntil ? new Date(body.blockedUntil).toLocaleTimeString() : '?'}.`,
          UNAUTHORIZED: 'Session expirée, reconnectez-vous.',
        }
        toast.push(messages[code] ?? `Modification refusée (${code}).`, 'error')
        if (body?.credit) setCredit(body.credit)
        setEpoch((n) => n + 1) // reload the document as the server has it
      },
    })

    const warn = (e: BeforeUnloadEvent) => {
      if (provider.unsentCount > 0) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)

    return () => {
      window.removeEventListener('beforeunload', warn)
      awareness.off('change', refreshPresence)
      provider.destroy()
      awareness.destroy()
      view.destroy()
      ydoc.destroy()
      setSynced(false)
    }
  }, [info?.docId, epoch, docId, session, setCredit])

  if (error)
    return (
      <div className="public">
        <ThemeToggle floating />
        <div className="card">
          <div className="icon-circle danger">
            <Icon name="lock" size={28} />
          </div>
          <h2>Accès impossible</h2>
          <p>{error}</p>
          <a href="#/">← Retour à mes documents</a>
        </div>
      </div>
    )

  const others = presence.filter((p) => !p.self)

  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand" title="Mes documents">
          <span className="logo">
            <Icon name="back" size={16} />
          </span>
        </a>
        <div className="editor-head">
          <h1>{info?.title ?? '…'}</h1>
          <span className={`pill ${status}`}>{status === 'online' && !synced ? 'Synchronisation…' : STATUS_LABEL[status]}</span>
          <span className={`pill ${save === 'saved' ? 'online' : 'saving'}`}>{SAVE_LABEL[save]}</span>
        </div>
        <div className="avatars" title={presence.map((p) => p.name).join(', ')}>
          {presence.slice(0, 6).map((p) => (
            <Avatar key={p.clientId} name={p.name} color={p.color} title={`${p.name}${p.self ? ' (vous)' : ''}${p.line ? ` — ligne ${p.line}` : ''}`} />
          ))}
        </div>
        {credit && <CreditMeter credit={credit} />}
        <ThemeToggle />
      </header>

      <main className="page wide">
        <div className="workspace">
          <section className={`paper ${synced ? '' : 'readonly'}`}>
            <div className="paper-head">
              <span>{synced ? `${chars.toLocaleString('fr-FR')} caractères` : 'Chargement du document…'}</span>
              <span>{others.length === 0 ? 'Vous êtes seul·e sur ce document' : `${others.length} autre(s) rédacteur(s) en ligne`}</span>
            </div>
            <div ref={host} />
          </section>

          <aside className="side">
            <div className="card">
              <h3 className="row" style={{ marginBottom: 12 }}>
                <Icon name="users" /> Présents ({presence.length})
              </h3>
              <div className="presence-list">
                {presence.map((p) => (
                  <div key={p.clientId} className="presence-item">
                    <Avatar name={p.name} color={p.color} />
                    <div className="grow">
                      {p.name} {p.self && <span className="badge">vous</span>}
                      <small>{p.line ? `écrit ligne ${p.line}` : 'consulte le document'}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <nav className="tabs">
                <button className={tab === 'share' ? 'active' : ''} onClick={() => setTab('share')}>
                  <Icon name="users" size={15} /> Partage
                </button>
                <button className={tab === 'versions' ? 'active' : ''} onClick={() => setTab('versions')}>
                  <Icon name="history" size={15} /> Versions
                </button>
                <button className={tab === 'links' ? 'active' : ''} onClick={() => setTab('links')}>
                  <Icon name="link" size={15} /> Liens
                </button>
              </nav>
              {info && tab === 'share' && <SharePanel info={info} onChange={loadInfo} toast={toast.push} />}
              {info && tab === 'versions' && <VersionsPanel docId={docId} toast={toast.push} />}
              {info && tab === 'links' && <LinksPanel docId={docId} toast={toast.push} />}
            </div>
          </aside>
        </div>
      </main>
      {toast.view}
    </>
  )
}

function SharePanel({ info, onChange, toast }: { info: DocInfo; onChange: () => void; toast: Toast }) {
  const [email, setEmail] = useState('')
  const add = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await api('POST', `/documents/${info.docId}/members`, { email })
      toast(`${email} peut maintenant écrire dans ce document.`, 'success')
      setEmail('')
      onChange()
    } catch (err: any) {
      toast(err.message, 'error')
    }
  }
  return (
    <div className="stack">
      <form onSubmit={add} className="row">
        <input type="email" placeholder="e-mail d'un rédacteur" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <button type="submit" className="icon-only" title="Donner accès">
          <Icon name="plus" />
        </button>
      </form>
      <ul className="list">
        {info.members.map((m) => (
          <li key={m.email}>
            <Avatar name={m.email} color={colorFor(m.email)} />
            <span className="grow">{m.email}</span>
            <span className={`badge ${m.role === 'owner' ? 'accent' : ''}`}>{m.role === 'owner' ? 'Propriétaire' : 'Éditeur'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface VersionMeta {
  versionId: string
  createdAt: string
  createdBy: string
  label: string
  length: number
}

function VersionsPanel({ docId, toast }: { docId: string; toast: Toast }) {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null)
  const [viewing, setViewing] = useState<{ v: VersionMeta; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => setVersions((await api<{ versions: VersionMeta[] }>('GET', `/documents/${docId}/versions`)).versions), [docId])
  useEffect(() => void load(), [load])

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      toast(ok, 'success')
      await load()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const view = async (v: VersionMeta) => setViewing({ v, text: (await api<{ text: string }>('GET', `/documents/${docId}/versions/${v.versionId}`)).text })

  return (
    <div className="stack">
      <button className="secondary" onClick={() => run(() => api('POST', `/documents/${docId}/versions`, {}), 'Version enregistrée.')} disabled={busy}>
        <Icon name="check" /> Enregistrer une version
      </button>
      <small>Une version automatique est aussi créée toutes les 10 minutes si le document a changé.</small>
      {viewing && (
        <div className="stack" style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong style={{ fontSize: '.9rem' }}>{new Date(viewing.v.createdAt).toLocaleString('fr-FR')}</strong>
            <button className="ghost icon-only" onClick={() => setViewing(null)}>
              <Icon name="x" />
            </button>
          </div>
          <pre className="preview" style={{ background: 'var(--surface)' }}>{viewing.text || '(document vide)'}</pre>
          <button
            onClick={() =>
              run(async () => {
                await api('POST', `/documents/${docId}/versions/${viewing.v.versionId}/restore`, {})
                setViewing(null)
              }, 'Version restaurée — l’état précédent a été sauvegardé.')
            }
            disabled={busy}
          >
            <Icon name="restore" /> Restaurer cette version
          </button>
        </div>
      )}
      <ul className="list">
        {versions?.length === 0 && <li className="muted">Aucune version pour l'instant.</li>}
        {versions?.map((v) => (
          <li key={v.versionId}>
            <span className="grow">
              {v.label}
              <small style={{ display: 'block' }}>
                {relativeTime(v.createdAt)} · {v.length.toLocaleString('fr-FR')} car. · {v.createdBy === 'system' ? 'automatique' : v.createdBy}
              </small>
            </span>
            <button className="ghost icon-only" title="Voir" onClick={() => view(v)}>
              <Icon name="eye" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface LinkInfo {
  linkId: string
  maxDownloads: number
  remaining: number
  createdAt: string
}

function LinksPanel({ docId, toast }: { docId: string; toast: Toast }) {
  const [links, setLinks] = useState<LinkInfo[] | null>(null)
  const [max, setMax] = useState(500)
  const load = useCallback(async () => setLinks((await api<{ links: LinkInfo[] }>('GET', `/documents/${docId}/links`)).links), [docId])
  useEffect(() => {
    void load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [load])

  const create = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const link = await api<{ notification?: string; creatorEmail: string }>('POST', `/documents/${docId}/links`, { maxDownloads: max })
      toast('Lien créé.', 'success')
      if (link.notification === 'pending')
        toast(
          `Pour être prévenu du dernier téléchargement : ouvrez l'e-mail « AWS Notification - Subscription Confirmation » reçu sur ${link.creatorEmail} et cliquez « Confirm subscription » (une seule fois).`,
          'info',
        )
      else if (link.notification === 'unavailable') toast("Le lien fonctionne, mais l'e-mail de dernier téléchargement n'a pas pu être activé.", 'error')
      await load()
    } catch (err: any) {
      toast(err.message, 'error')
    }
  }
  const url = (id: string) => `${window.location.origin}${window.location.pathname}#/d/${id}`
  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(url(id))
      toast('Lien copié dans le presse-papiers.', 'success')
    } catch {
      toast(url(id))
    }
  }

  return (
    <div className="stack">
      <form onSubmit={create} className="row" style={{ alignItems: 'flex-end' }}>
        <label style={{ flex: 1 }}>
          Exemplaires autorisés
          <input type="number" min={1} max={100000} value={max} onChange={(e) => setMax(Number(e.target.value))} required />
        </label>
        <button type="submit">
          <Icon name="link" /> Créer
        </button>
      </form>
      <small>Le PDF reflète toujours le document au moment du téléchargement : inutile de recréer un lien après une correction.</small>
      <ul className="list">
        {links?.length === 0 && <li className="muted">Aucun lien pour ce document.</li>}
        {links
          ?.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((l) => {
            const used = l.maxDownloads - l.remaining
            return (
              <li key={l.linkId} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className={`badge ${l.remaining > 0 ? 'success' : ''}`}>{l.remaining > 0 ? 'Actif' : 'Épuisé'}</span>
                  <small>
                    {used} / {l.maxDownloads} téléchargés
                  </small>
                </div>
                <div className={`progress ${l.remaining === 0 ? 'done' : ''}`}>
                  <div style={{ width: `${(used / l.maxDownloads) * 100}%` }} />
                </div>
                <div className="link-box">
                  <input readOnly value={url(l.linkId)} onFocus={(e) => e.target.select()} />
                  <button className="secondary icon-only" onClick={() => copy(l.linkId)} title="Copier">
                    <Icon name="copy" size={16} />
                  </button>
                </div>
              </li>
            )
          })}
      </ul>
    </div>
  )
}


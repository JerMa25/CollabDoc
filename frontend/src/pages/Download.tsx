// Public download page (#/d/<linkId>). Visitors give no identity.
// The visitor always knows where they stand: available / please wait / downloading / exhausted.
//  - The link status is polled through CloudFront (/public/..., cached 2 s), so thousands of
//    open pages learn quickly that the link is exhausted without loading the API.
//  - A download attempt that gets 429 (throttled during the peak) or 5xx is retried
//    automatically with exponential backoff + jitter, and the page says so.
import { useEffect, useRef, useState } from 'react'
import { cfg } from '../api'
import { Brand, Icon, ThemeToggle } from '../ui'

type State =
  | { kind: 'loading' }
  | { kind: 'available'; title: string; remaining: number; max: number }
  | { kind: 'claiming' }
  | { kind: 'waiting'; until: number; attempt: number }
  | { kind: 'downloading'; copy: number; max?: number; url: string }
  | { kind: 'exhausted'; title?: string }
  | { kind: 'notfound' }

const POLL_MS = 5000

export function Download({ linkId }: { linkId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [, tick] = useState(0)
  const stateRef = useRef(state)
  stateRef.current = state
  const info = useRef<{ title?: string; max?: number }>({})

  // Status polling (cheap, cached by CloudFront).
  useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const res = await fetch(`/public/links/${encodeURIComponent(linkId)}`)
        const data = await res.json()
        if (stop) return
        if (data.docTitle) info.current = { title: data.docTitle, max: data.maxDownloads }
        const current = stateRef.current.kind
        if (res.status === 404) setState({ kind: 'notfound' })
        else if (data.status === 'exhausted' && current !== 'downloading') setState({ kind: 'exhausted', title: data.docTitle ?? info.current.title })
        else if (res.ok && (current === 'loading' || current === 'available'))
          setState({ kind: 'available', title: data.docTitle, remaining: data.remaining, max: data.maxDownloads })
      } catch {
        /* keep the current state, try again */
      }
      if (!stop && ['loading', 'available', 'waiting'].includes(stateRef.current.kind)) timer = setTimeout(poll, POLL_MS + Math.random() * 2000)
    }
    timer = setTimeout(poll, 0)
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [linkId])

  // Live countdown while waiting.
  useEffect(() => {
    if (state.kind !== 'waiting') return
    const t = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [state.kind])

  const claim = async (attempt = 0): Promise<void> => {
    if (attempt === 0) setState({ kind: 'claiming' })
    try {
      const res = await fetch(`${cfg.apiUrl}/links/${encodeURIComponent(linkId)}/claim`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.status === 200 && data.status === 'ok') {
        setState({ kind: 'downloading', copy: data.copyNumber, max: info.current.max, url: data.url })
        window.location.href = data.url
        return
      }
      if (res.status === 410) return setState({ kind: 'exhausted', title: info.current.title })
      if (res.status === 404) return setState({ kind: 'notfound' })
      // 429 (peak throttling) / 5xx: wait and retry
    } catch {
      /* network error: wait and retry */
    }
    if (stateRef.current.kind === 'exhausted') return
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random() / 2)
    setState({ kind: 'waiting', until: Date.now() + delay, attempt: attempt + 1 })
    setTimeout(() => {
      if (stateRef.current.kind === 'waiting') void claim(attempt + 1)
    }, delay)
  }

  return (
    <div className="public">
      <ThemeToggle floating />
      <div className="card">
        <Brand href="#" />
        {state.kind === 'loading' && <div className="spinner" />}

        {state.kind === 'notfound' && (
          <>
            <div className="icon-circle danger">
              <Icon name="alert" size={28} />
            </div>
            <h2>Lien introuvable</h2>
            <p>Ce lien de téléchargement n'existe pas. Vérifiez l'adresse reçue.</p>
          </>
        )}

        {state.kind === 'available' && (
          <>
            <div className="icon-circle">
              <Icon name="doc" size={28} />
            </div>
            <h2>{state.title}</h2>
            <div className="counter">
              {state.remaining.toLocaleString('fr-FR')} <small>/ {state.max.toLocaleString('fr-FR')} exemplaires restants</small>
            </div>
            <div className="progress">
              <div style={{ width: `${(state.remaining / state.max) * 100}%` }} />
            </div>
            <button className="big" onClick={() => claim()} style={{ width: '100%' }}>
              <Icon name="download" /> Télécharger le PDF
            </button>
            <small>Version à jour au moment du téléchargement · aucune inscription nécessaire</small>
          </>
        )}

        {state.kind === 'claiming' && (
          <>
            <div className="spinner" />
            <h2>Réservation de votre exemplaire…</h2>
          </>
        )}

        {state.kind === 'waiting' && (
          <>
            <div className="icon-circle warning pulse">
              <Icon name="hourglass" size={28} />
            </div>
            <h2>Forte affluence — veuillez patienter</h2>
            <p>
              Votre demande n'est pas perdue. Nouvel essai automatique dans <b>{Math.max(0, Math.ceil((state.until - Date.now()) / 1000))} s</b>.
            </p>
            <small>Tentative {state.attempt} · ne fermez pas cette page</small>
          </>
        )}

        {state.kind === 'downloading' && (
          <>
            <div className="icon-circle success">
              <Icon name="check" size={28} />
            </div>
            <h2>C'est à vous !</h2>
            <p>
              Vous avez obtenu l'exemplaire <b>n°{state.copy}</b>
              {state.max ? ` sur ${state.max}` : ''}. Le téléchargement démarre.
            </p>
            <a className="btn" href={state.url} style={{ color: '#fff', textDecoration: 'none' }}>
              <Icon name="download" /> Relancer le téléchargement
            </a>
            <small>Ce bouton reste valable 60 secondes.</small>
          </>
        )}

        {state.kind === 'exhausted' && (
          <>
            <div className="icon-circle danger">
              <Icon name="lock" size={28} />
            </div>
            <h2>Lien épuisé</h2>
            <p>Tous les exemplaires {state.title ? `de « ${state.title} » ` : ''}ont été distribués. Ce lien ne permet plus de télécharger.</p>
          </>
        )}
      </div>
    </div>
  )
}

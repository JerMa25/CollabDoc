import { useState, type FormEvent } from 'react'
import { api, setSession, type Session } from '../api'
import { Brand, Icon, ThemeToggle } from '../ui'

const FEATURES = [
  { icon: 'users', title: 'Écriture à plusieurs, en direct', text: 'Chacun voit les modifications des autres, qui est présent et où il écrit.' },
  { icon: 'history', title: 'Historique des versions', text: 'Consultez et restaurez une version précédente à tout moment.' },
  { icon: 'link', title: 'Liens de téléchargement PDF', text: "Un nombre d'exemplaires limité, toujours à jour au moment du téléchargement." },
]

export function Login({ onLogin }: { onLogin: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      setSession(await api<Session>('POST', '/session', { name, email }))
      onLogin()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <section className="auth-hero">
        <Brand />
        <h1>Le journal de l'association, écrit ensemble.</h1>
        <p>Rédigez à plusieurs dans le même document, puis diffusez-le en PDF par un lien au nombre d'exemplaires maîtrisé.</p>
        <div className="features">
          {FEATURES.map((f) => (
            <div className="feature" key={f.title}>
              <span className="icon-box">
                <Icon name={f.icon} />
              </span>
              <div>
                <strong>{f.title}</strong>
                <span>{f.text}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="auth-form">
        <ThemeToggle floating />
        <form onSubmit={submit} className="card stack">
          <div>
            <h2>Entrer dans l'espace de rédaction</h2>
            <small>Pas de compte à créer : votre nom et votre e-mail suffisent.</small>
          </div>
          <label>
            Nom
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus placeholder="Ex. Aïcha Mbarga" />
          </label>
          <label>
            E-mail
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="vous@exemple.com" />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="big" disabled={busy}>
            {busy ? 'Connexion…' : 'Entrer'}
          </button>
          <small>Crédit d'écriture : 10 000 caractères par jour et par personne.</small>
        </form>
      </section>
    </div>
  )
}

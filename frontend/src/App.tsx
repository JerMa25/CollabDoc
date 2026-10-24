// Hash-based routing (#/...): the site is static files on S3/CloudFront, no server routing needed.
import { useEffect, useState } from 'react'
import { getSession } from './api'
import { Admin } from './pages/Admin'
import { Documents } from './pages/Documents'
import { Download } from './pages/Download'
import { Editor } from './pages/Editor'
import { Login } from './pages/Login'

const useHash = () => {
  const [hash, setHash] = useState(window.location.hash.slice(1) || '/')
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

export function App() {
  const path = useHash()
  const [, refresh] = useState(0)

  // Public pages: no identity needed.
  const download = path.match(/^\/d\/([\w-]+)$/)
  if (download) return <Download linkId={download[1]} />
  if (path === '/admin') return <Admin />

  const session = getSession()
  if (!session) return <Login onLogin={() => refresh((n) => n + 1)} />

  const doc = path.match(/^\/doc\/([\w-]+)$/)
  if (doc) return <Editor key={doc[1]} docId={doc[1]} session={session} />
  return <Documents session={session} onLogout={() => refresh((n) => n + 1)} />
}

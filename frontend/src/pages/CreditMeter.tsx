import type { Credit } from '../api'

export function CreditMeter({ credit }: { credit: Credit }) {
  const pct = Math.min(100, (credit.used / credit.limit) * 100)
  const reset = new Date(credit.resetsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const level = credit.remaining === 0 ? 'empty' : credit.remaining < credit.limit * 0.1 ? 'low' : ''
  return (
    <div className="credit" title={`Crédit rechargé chaque jour à ${reset}`}>
      <div className="meter">
        <div style={{ width: `${100 - pct}%` }} className={level} />
      </div>
      <span>
        <b>{credit.remaining.toLocaleString('fr-FR')}</b> car. restants
      </span>
    </div>
  )
}

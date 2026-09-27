import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ZernioStatusCheck as StatusCheck } from '../../shared/zernio'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { Button } from './ui/Button'
import { platformName } from './PlatformIcon'

export function ZernioStatusCheck({ accounts, disabled }: {
  accounts: { accountId: string; platform: string; label: string }[]
  disabled: boolean
}): React.JSX.Element {
  const [result, setResult] = useState<StatusCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const request = useRef(0)

  useEffect(() => {
    const unsubscribe = getApi().zernio.onReset(() => {
      request.current++
      setResult(null); setError(null); setChecking(false)
    })
    return () => { request.current++; unsubscribe() }
  }, [])

  const check = async (): Promise<void> => {
    const current = ++request.current
    setChecking(true); setResult(null); setError(null)
    try {
      const response = await getApi().zernio.checkStatus()
      if (current === request.current) setResult(response)
    } catch (cause) {
      if (current === request.current) setError(errorMessage(cause, 'Could not check Zernio status. Try again.'))
    } finally { if (current === request.current) setChecking(false) }
  }

  return <div className="mt-1.5">
    <Button size="sm" variant="ghost" loading={checking} disabled={disabled || accounts.length === 0} icon={<RefreshCw className="h-3 w-3" />} onClick={() => void check()} title="Checks account health without uploading or posting a video">Check Zernio status</Button>
    {error && <p role="alert" className="mt-1 text-2xs text-danger">Status check failed: {error}</p>}
    {result && <div role="status" aria-label="Zernio status check" className="mt-2 space-y-1.5 rounded-xl bg-white/[0.03] px-3 py-2 text-2xs">
      <p className="text-ink-subtle">Checked {new Date(result.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
      {accounts.map((account) => {
        const status = result.accounts.find((item) => item.accountId === account.accountId)
        const problem = status?.needsReconnect || status?.canPost === false || status?.health === 'error' || status?.health === 'warning' || Boolean(status?.issue)
        const healthy = !problem && status?.health === 'healthy' && status?.canPost === true
        return <div key={account.accountId}>
          <p className="text-ink"><span className="font-medium">{account.label}</span> · {platformName(account.platform)}</p>
          <p className={problem ? 'text-warning' : 'text-ink-muted'}>{status?.needsReconnect ? 'Reconnect this account in Accounts.' : problem ? 'Zernio reports an account issue.' : healthy ? 'Connection and permissions look good.' : 'Zernio did not return a complete account status.'}</p>
          {status?.issue && <p className="text-warning">{status.issue}</p>}
        </div>
      })}
      <p className="border-t border-white/[0.06] pt-1.5 text-ink-muted"><span className="font-medium text-ink">Upload hold: unconfirmed.</span> Zernio’s status check does not report whether its upload hold has ended. No video was uploaded or posted.</p>
    </div>}
  </div>
}

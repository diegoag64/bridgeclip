import { Fragment, useCallback, useEffect, useState } from 'react'
import { Layout } from './components/Layout'
import { NAV_ITEMS, SIDEBAR_SHORTCUT_KEY, type Page } from './components/Sidebar'
import { ClipPage } from './pages/ClipPage'
import { LibraryPage } from './pages/LibraryPage'
import { JobsPage } from './pages/JobsPage'
import { SettingsPage } from './pages/SettingsPage'
import { AccountsPage } from './pages/AccountsPage'
import { PostsPage } from './pages/PostsPage'
import { AutomationsPage } from './pages/AutomationsPage'
import { BridgeClipLogo } from './components/brand/BridgeClipLogo'
import { useSettingsStore } from './store/use-settings-store'
import { useJobStore } from './store/use-job-store'
import { useSidebarStore } from './store/use-sidebar-store'
import { useUpdateStore } from './store/use-update-store'
import { Button } from './components/ui/Button'
import { getApi } from './lib/ipc'

export default function App(): React.JSX.Element {
  const [loadError, setLoadError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [page, setPage] = useState<Page>('clip')
  const [pageVisit, setPageVisit] = useState(0)
  /** Set when Help → Check for Updates… asks for Settings → About. */
  const [showUpdates, setShowUpdates] = useState(0)

  const loadSettings = useSettingsStore((s) => s.load)
  const checkTools = useSettingsStore((s) => s.checkTools)
  const settingsLoaded = useSettingsStore((s) => s.loaded)

  // Sidebar destinations always open the page root, even when already active.
  // In-page navigation keeps setPage so links to a specific job retain focus.
  const navigateRoot = useCallback((destination: Page): void => {
    // Keep a modal's progress and cancel controls mounted during an upload.
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
    if (destination === 'jobs') useJobStore.getState().focusJob(null)
    setPage(destination)
    setPageVisit((visit) => visit + 1)
  }, [])

  useEffect(() => {
    setLoadError(false)
    void loadSettings().then(() => checkTools()).catch(() => setLoadError(true))
  }, [loadSettings, checkTools, retry])

  // The main process owns the job list. Subscribe first, then load the list,
  // so a reload or reopened window picks up jobs that are still running.
  useEffect(() => {
    const api = getApi()
    const unsubscribe = api.job.onUpdate((job) => useJobStore.getState().upsert(job))
    void api.job.list().then((jobs) => useJobStore.getState().hydrate(jobs)).catch(() => {})
    return unsubscribe
  }, [])

  // Update state lives in the main process, which keeps checking in the
  // background. Subscribe first, then read it, so no change is missed.
  useEffect(() => {
    const api = getApi()
    const unsubscribes = [
      api.update.onState((state) => useUpdateStore.getState().set(state)),
      api.update.onShow(() => {
        setPage('settings')
        setShowUpdates((count) => count + 1)
      })
    ]
    void api.update.getState().then((state) => useUpdateStore.getState().set(state)).catch(() => {})
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [])

  // ⌘1 Create, ⌘2 Library, ⌘3 Jobs, ⌘4 Accounts, ⌘5 Posts, ⌘6 Automations, ⌘, Settings,
  // ⌘\ collapse or expand the sidebar (Ctrl on Windows/Linux).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key === SIDEBAR_SHORTCUT_KEY) {
        e.preventDefault()
        useSidebarStore.getState().toggle()
        return
      }
      const item = NAV_ITEMS.find((n) => n.shortcut === e.key)
      if (!item) return
      e.preventDefault()
      navigateRoot(item.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigateRoot])

  // Each page starts at the top.
  useEffect(() => {
    document.getElementById('page-scroll')?.scrollTo({ top: 0 })
  }, [page, pageVisit])

  return (
    <>
      {settingsLoaded ? (
        <Layout currentPage={page} onNavigate={navigateRoot}>
          <Fragment key={pageVisit}>
            {page === 'clip' && <ClipPage onNavigate={setPage} />}
            {page === 'library' && <LibraryPage onNavigate={setPage} />}
            {page === 'jobs' && <JobsPage onNavigate={setPage} />}
            {page === 'accounts' && <AccountsPage onNavigate={setPage} />}
            {page === 'posts' && <PostsPage onNavigate={setPage} />}
            {page === 'automations' && <AutomationsPage onNavigate={setPage} />}
            {page === 'settings' && <SettingsPage showUpdates={showUpdates} />}
          </Fragment>
        </Layout>
      ) : (
        <div className="app-backdrop drag flex h-screen items-center justify-center">
          {loadError ? (
            <div className="glass no-drag space-y-3 rounded-3xl px-5 py-5 text-center animate-pop-in">
              <p role="alert" className="text-sm text-danger">Could not load settings. Please try again.</p>
              <Button onClick={() => setRetry((value) => value + 1)}>Retry</Button>
            </div>
          ) : <BridgeClipLogo className="h-7 animate-pulse opacity-80" />}
        </div>
      )}
    </>
  )
}

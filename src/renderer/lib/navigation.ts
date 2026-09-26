/** Editors finish a pending save before in-app navigation can unmount them. */
let commit: (() => Promise<void>) | null = null
export function registerNavigationCommit(save: () => Promise<void>): () => void {
  commit = save
  return () => { if (commit === save) commit = null }
}
export async function commitBeforeNavigation(): Promise<void> { await commit?.() }

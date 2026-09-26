import type { MetadataEnhancement } from '../../shared/automations'
import { platformName } from './PlatformIcon'

export function MetadataDraftPreview({ draft }: { draft: MetadataEnhancement }): React.JSX.Element {
  return <div className="space-y-3">
    {draft.posts.map((post) => <section key={post.platform} className="glass-well rounded-xl p-4">
      <h3 className="text-sm font-semibold text-ink">{platformName(post.platform)}</h3>
      {post.title && <p className="mt-2 font-medium text-ink" data-selectable>{post.title}</p>}
      <p className="mt-2 whitespace-pre-wrap text-sm text-ink-muted" data-selectable>{post.caption}</p>
      {post.tags.length > 0 && <p className="mt-2 text-xs text-ink-subtle">Tags: {post.tags.join(', ')}</p>}
      {post.categoryId && <p className="mt-2 text-xs text-ink-subtle">Category: {post.categoryId}</p>}
      {post.topicTag && <p className="mt-2 text-xs text-ink-subtle">Topic: {post.topicTag}</p>}
    </section>)}
    <details className="glass-well rounded-xl p-3 text-xs text-ink-muted" open={draft.research.status === 'unavailable'}>
      <summary className="cursor-pointer font-medium text-ink">Context & research · {draft.research.status}{draft.research.reused ? ' · reused video research' : ''}</summary>
      <p className="mt-2 whitespace-pre-wrap" data-selectable>{draft.source?.title || 'No original video identified'}{draft.source?.channel ? ` · ${draft.source.channel}` : ''}</p>
      <p className="mt-2 whitespace-pre-wrap" data-selectable>{draft.source?.description || 'Original description unavailable; no description was assumed.'}</p>
      <p className="mt-3 whitespace-pre-wrap" data-selectable>{draft.research.summary}</p>
      {draft.research.sources.map((citation) => <p key={citation.url} className="mt-2 break-all" data-selectable>{citation.title}<br />{citation.url}</p>)}
    </details>
  </div>
}

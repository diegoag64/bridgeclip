import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Ellipsis } from 'lucide-react'
import { MENU_SURFACE } from './Select'
import { cn } from '../../lib/utils'

interface Action {
  label: string
  icon?: ReactNode
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
}

/** A keyboard-accessible actions menu that stays above scrolling panels. */
export function ActionMenu({ label, actions, disabled, icon, triggerClassName }: { label: string; actions: Action[]; disabled?: boolean; icon?: ReactNode; triggerClassName?: string }): React.JSX.Element {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const last = useRef(false)
  const [open, setOpen] = useState(false)
  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const element = menu.current
    if (!element) return
    element.showPopover?.()
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      element.style.left = `${Math.max(8, Math.min(rect.right - element.offsetWidth, window.innerWidth - element.offsetWidth - 8))}px`
      element.style.top = `${Math.max(8, rect.bottom + element.offsetHeight + 12 <= window.innerHeight ? rect.bottom + 4 : rect.top - element.offsetHeight - 4)}px`
    }
    place()
    const enabled = element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    enabled[last.current ? enabled.length - 1 : 0]?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close()
    }
    const blur = (): void => close()
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', blur)
    }
  }, [open, close])

  useEffect(() => { if (disabled) close() }, [disabled, close])

  return <>
    <button ref={trigger} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled} className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-white/[0.08] hover:text-ink disabled:opacity-40', triggerClassName)}
      onClick={() => { last.current = false; setOpen(!open) }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); last.current = event.key === 'ArrowUp'; setOpen(true) }
      }}>{icon ?? <Ellipsis aria-hidden className="h-4 w-4" />}</button>
    {open && <div ref={menu} id={id} role="menu" aria-label={label} popover="manual"
      className={cn(MENU_SURFACE, 'fixed inset-auto z-[120] m-0 min-w-40 border-0')} style={{ top: -9999, left: -9999 }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
        else if (event.key === 'Tab') close(true)
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          items[next]?.focus()
        }
      }}>
      {actions.map((action) => <button key={action.label} type="button" role="menuitem" disabled={action.disabled}
        className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-white/[0.08] focus:bg-white/[0.08] disabled:opacity-40', action.danger ? 'text-danger' : 'text-ink')}
        onClick={() => { close(true); action.onSelect() }}>{action.icon}{action.label}</button>)}
    </div>}
  </>
}

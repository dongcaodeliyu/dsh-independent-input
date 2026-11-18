// Pure physical-pixel policy. Resolving a preference never moves/opens a window.
export function resolvePreferredMonitor(monitors = [], preference = 'secondary') {
  const list = monitors.filter(m => m?.workArea?.width > 0 && m?.workArea?.height > 0)
  const requested = typeof preference === 'string' && preference.trim() ? preference.trim() : 'secondary'
  let monitor = !['secondary','primary'].includes(requested.toLowerCase())
    ? list.find(m => m.device?.toLowerCase() === requested.toLowerCase()) : null
  let reason = monitor ? 'configured-device' : null
  if (!monitor && requested.toLowerCase() === 'primary') { monitor = list.find(m => m.primary); reason = 'configured-primary' }
  if (!monitor) { monitor = list.find(m => !m.primary); reason = requested.toLowerCase() === 'secondary' ? 'secondary-first' : 'requested-unavailable-secondary' }
  if (!monitor) { monitor = list.find(m => m.primary) || list[0]; reason = 'single-monitor-or-primary-fallback' }
  return { preference: requested, available: Boolean(monitor), reason: monitor ? reason : 'no-monitor', monitor: monitor || null }
}

export function preferredWindowBounds(rect, monitor) {
  const w = monitor?.workArea
  if (!w || ![w.x,w.y,w.width,w.height,rect?.width,rect?.height].every(Number.isFinite) || w.width < 1 || w.height < 1 || rect.width < 1 || rect.height < 1) throw new Error('Valid physical window/workarea geometry required')
  const width = Math.min(Math.round(rect.width), Math.floor(w.width))
  const height = Math.min(Math.round(rect.height), Math.floor(w.height))
  return { x: Math.round(w.x + (w.width - width) / 2), y: Math.round(w.y + (w.height - height) / 2), width, height }
}

const hasReidId = (value) => String(value ?? '').trim() !== ''

export const assignReidLidsByGid = (annotations, currentFrame, imageIsVideo) => {
  const usedLids = new Set(annotations.flatMap((item) => {
    if (item.type !== 'reid' || item.auto_lid === true) return []
    const value = String(item.track_id ?? '').trim()
    const numeric = Number(value)
    return /^\d+$/.test(value) && Number.isInteger(numeric) && numeric > 0 ? [numeric] : []
  }))
  const candidates = annotations.map((item, originalIndex) => ({ item, originalIndex })).filter(({ item }) => item.type === 'reid'
    && (!imageIsVideo || item.frame_id === currentFrame)
    && (item.auto_lid === true || !hasReidId(item.track_id))
    && hasReidId(item.identity_id))
    .sort((first, second) => String(first.item.identity_id).trim().localeCompare(String(second.item.identity_id).trim(), undefined, { numeric: true, sensitivity: 'base' })
      || first.originalIndex - second.originalIndex)
  const assignedLids = new Map()
  let nextLid = 1
  candidates.forEach(({ item }) => {
    while (usedLids.has(nextLid)) nextLid += 1
    assignedLids.set(item.id, nextLid)
    usedLids.add(nextLid)
    nextLid += 1
  })
  let changed = false
  const result = annotations.map((item) => {
    if (assignedLids.has(item.id)) {
      const trackId = assignedLids.get(item.id)
      if (item.track_id === trackId && item.auto_lid === true) return item
      changed = true
      return { ...item, track_id: trackId, auto_lid: true }
    }
    if (item.auto_lid === true && (!imageIsVideo || item.frame_id === currentFrame) && !hasReidId(item.identity_id)) {
      changed = true
      return { ...item, track_id: null, auto_lid: false }
    }
    return item
  })
  return changed ? result : annotations
}

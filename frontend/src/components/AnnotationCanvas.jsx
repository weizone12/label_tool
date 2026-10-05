import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createId } from '../uuid'
import { boundaryChains, insertSharedVertices, isSegmentation } from '../segmentationTopology'
import { fitBoxWithinBounds } from '../reidGeometry'

export const DEFAULT_SNAP_TOLERANCE = 10

const distanceToSegment = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y
  const length2 = dx * dx + dy * dy
  if (!length2) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

const pointInPolygon = (p, points) => {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j]
    if (((a.y > p.y) !== (b.y > p.y)) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside
  }
  return inside
}

const rotatedPoints = (a, b, third) => {
  const dx = b.x - a.x, dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  const nx = -dy / length, ny = dx / length
  const height = (third.x - a.x) * nx + (third.y - a.y) * ny
  return [a, b, { x: b.x + nx * height, y: b.y + ny * height }, { x: a.x + nx * height, y: a.y + ny * height }]
}

const annotationPoints = (item) => {
  if (['rectangle', 'reid'].includes(item.type)) {
    const [a, b] = item.points
    return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
  }
  return item.points
}

const movePoints = (points, dx, dy) => points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }))

const editVertex = (item, vertexIndex, point) => {
  if (['rectangle', 'reid'].includes(item.type)) {
    const displayed = annotationPoints(item)
    return [point, displayed[(vertexIndex + 2) % 4]]
  }
  return item.points.map((current, index) => index === vertexIndex ? { ...current, x: point.x, y: point.y } : current)
}

const nearestTimelineFrame = (timeline, time) => {
  if (!timeline?.length) return Math.round(time * 30)
  let low = 0, high = timeline.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (timeline[middle].video_pts_s < time) low = middle + 1
    else high = middle
  }
  const next = timeline[low]
  const previous = timeline[Math.max(0, low - 1)]
  return Math.abs(previous.video_pts_s - time) <= Math.abs(next.video_pts_s - time) ? previous.frame_index : next.frame_index
}

const reidInfoValue = (input) => {
  const text = input === undefined || input === null || String(input).trim() === '' ? '—' : String(input)
  return text.length > 24 ? `${text.slice(0, 21)}…` : text
}

const reidInfoRows = (item, label) => {
  const rows = [`GID: ${reidInfoValue(item.identity_id)}`, `LID: ${reidInfoValue(item.track_id)}`]
  const mmsiAttribute = label?.attributes?.find((attribute) => String(attribute.name || attribute.id || '').trim().toLocaleLowerCase() === 'mmsi')
  const mmsiKey = mmsiAttribute?.id || 'mmsi'
  if (Object.prototype.hasOwnProperty.call(item.attributes || {}, mmsiKey)) rows.push(`MMSI: ${reidInfoValue(item.attributes[mmsiKey])}`)
  return rows
}

const rectanglesOverlap = (first, second, padding = 0) => (
  first.x < second.x + second.width + padding
  && first.x + first.width + padding > second.x
  && first.y < second.y + second.height + padding
  && first.y + first.height + padding > second.y
)

const overlapArea = (first, second, padding = 0) => {
  const width = Math.min(first.x + first.width + padding, second.x + second.width + padding) - Math.max(first.x, second.x)
  const height = Math.min(first.y + first.height + padding, second.y + second.height + padding) - Math.max(first.y, second.y)
  return Math.max(0, width) * Math.max(0, height)
}

const layoutReidInfoTags = (annotations, labels, selectedId, zoom, imageWidth, imageHeight) => {
  const labelById = new Map(labels.map((label) => [label.id, label]))
  const occupied = []
  const gap = 6 / zoom
  const padding = 4 / zoom
  const clampCandidate = (candidate, width, height) => ({
    x: Math.max(0, Math.min(Math.max(0, imageWidth - width), candidate.x)),
    y: Math.max(0, Math.min(Math.max(0, imageHeight - height), candidate.y)),
    width,
    height,
  })
  const items = annotations.filter((item) => item.type === 'reid').map((item) => {
    const rows = reidInfoRows(item, labelById.get(item.labelId))
    const width = Math.max(78, Math.max(...rows.map((row) => row.length)) * 6.7 + 10) / zoom
    const height = (rows.length * 14 + 8) / zoom
    const left = Math.min(item.points[0].x, item.points[1].x)
    const top = Math.min(item.points[0].y, item.points[1].y)
    const right = Math.max(item.points[0].x, item.points[1].x)
    const bottom = Math.max(item.points[0].y, item.points[1].y)
    return { item, rows, width, height, left, top, right, bottom, selected: item.id === selectedId }
  }).sort((first, second) => Number(second.selected) - Number(first.selected) || first.top - second.top || first.left - second.left)

  return items.map((entry) => {
    const { item, rows, width, height, left, top, right, bottom, selected } = entry
    const baseX = (left + right - width) / 2
    const baseY = top - height - gap
    const step = height + gap
    const rawCandidates = []
    for (let layer = 0; layer <= 16; layer += 1) rawCandidates.push({ x: baseX, y: baseY - layer * step })
    const horizontalStep = width + gap
    for (let column = 1; column <= 12; column += 1) {
      rawCandidates.push({ x: baseX - column * horizontalStep, y: baseY }, { x: baseX + column * horizontalStep, y: baseY })
    }
    for (let layer = 1; layer <= 8; layer += 1) {
      for (let column = 1; column <= 6; column += 1) {
        rawCandidates.push(
          { x: baseX - column * horizontalStep, y: baseY - layer * step },
          { x: baseX + column * horizontalStep, y: baseY - layer * step },
        )
      }
    }
    const seen = new Set()
    const candidates = rawCandidates.map((candidate) => clampCandidate(candidate, width, height)).filter((candidate) => {
      const key = `${candidate.x.toFixed(3)}:${candidate.y.toFixed(3)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    let placement = candidates.find((candidate) => !occupied.some((current) => rectanglesOverlap(candidate, current, padding)))
    if (!placement) {
      const preferred = candidates[0]
      placement = candidates.reduce((best, candidate) => {
        const overlap = occupied.reduce((sum, current) => sum + overlapArea(candidate, current, padding), 0)
        const distance = Math.hypot(candidate.x - preferred.x, candidate.y - preferred.y)
        const score = overlap * 1000 + distance
        return !best || score < best.score ? { ...candidate, score } : best
      }, null)
    }
    const placed = { x: placement.x, y: placement.y, width, height }
    occupied.push(placed)
    const tagCenter = { x: placed.x + width / 2, y: placed.y + height / 2 }
    const lineStart = { x: Math.max(left, Math.min(right, tagCenter.x)), y: Math.max(top, Math.min(bottom, tagCenter.y)) }
    const lineEnd = { x: Math.max(placed.x, Math.min(placed.x + width, lineStart.x)), y: Math.max(placed.y, Math.min(placed.y + height, lineStart.y)) }
    const leaderLength = Math.hypot(lineEnd.x - lineStart.x, lineEnd.y - lineStart.y)
    return {
      ...placed,
      id: item.id,
      rows,
      color: labelById.get(item.labelId)?.color || '#fff',
      selected,
      leader: leaderLength > 1 / zoom,
      lineStart,
      lineEnd,
    }
  })
}

export default function AnnotationCanvas({ image, imageUrl, annotations, labels, activeLabelId, tool, selectedId, onSelect, onCommit, onUpdate, onDraftActiveChange, resetToken, currentFrame = 0, onFrameChange, readOnlyGeometry = false, frameTimeline = [], onVideoMetadata, overlayPoints = [], showReidInfo = false, snapTolerance = DEFAULT_SNAP_TOLERANCE }) {
  const svgRef = useRef(null)
  const videoRef = useRef(null)
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const [draft, setDraft] = useState([])
  const [draftInsertions, setDraftInsertions] = useState([])
  const [draftActions, setDraftActions] = useState([])
  const [routeToggle, setRouteToggle] = useState(false)
  const [cursor, setCursor] = useState(null)
  const [interaction, setInteraction] = useState(null)
  const [dragPreview, setDragPreview] = useState(null)
  const cycleRef = useRef({ x: 0, y: 0, index: -1 })
  const visibleAnnotations = useMemo(() => annotations.filter((item) => !item.hidden), [annotations])

  useEffect(() => { setView({ x: 0, y: 0, zoom: 1 }); setDraft([]); setDraftInsertions([]); setDraftActions([]); setRouteToggle(false) }, [image.id, resetToken])
  useEffect(() => { setDraft([]); setDraftInsertions([]); setDraftActions([]); setRouteToggle(false) }, [tool])
  useEffect(() => { onDraftActiveChange?.(draft.length > 0) }, [draft.length, onDraftActiveChange])
  useEffect(() => () => onDraftActiveChange?.(false), [onDraftActiveChange])

  const screenToImage = useCallback((event) => {
    const svg = svgRef.current
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY
    const transformed = point.matrixTransform(svg.getScreenCTM().inverse())
    return { x: Math.max(0, Math.min(image.width, transformed.x)), y: Math.max(0, Math.min(image.height, transformed.y)) }
  }, [image.height, image.width])

  const imageToScreen = (point) => {
    const svgPoint = svgRef.current.createSVGPoint()
    svgPoint.x = point.x; svgPoint.y = point.y
    return svgPoint.matrixTransform(svgRef.current.getScreenCTM())
  }

  const topologyAnnotations = (includeHidden = false) => insertSharedVertices(
    (includeHidden ? annotations : visibleAnnotations).filter((item) => item.type === tool),
    draftInsertions,
  )

  const sharedEdgeInsertions = (snap, point) => topologyAnnotations(true).flatMap((annotation) => annotation.points.flatMap((start, index) => {
    const end = annotation.points[(index + 1) % annotation.points.length]
    const sameDirection = start.vertexId === snap.startVertexId && end.vertexId === snap.endVertexId
    const reverseDirection = start.vertexId === snap.endVertexId && end.vertexId === snap.startVertexId
    if (!sameDirection && !reverseDirection) return []
    return [{
      annotationId: annotation.id,
      startVertexId: start.vertexId,
      endVertexId: end.vertexId,
      t: sameDirection ? snap.t : 1 - snap.t,
      point,
    }]
  }))

  const findTopologySnap = (event) => {
    if (!isSegmentation(tool)) return null
    const candidates = topologyAnnotations()
    let nearestVertex = null
    for (const annotation of candidates) {
      for (const point of annotation.points) {
        const screen = imageToScreen(point)
        const distance = Math.hypot(event.clientX - screen.x, event.clientY - screen.y)
        if (distance <= snapTolerance && (!nearestVertex || distance < nearestVertex.distance)) {
          nearestVertex = { kind: 'vertex', point, annotationId: annotation.id, distance }
        }
      }
    }
    if (nearestVertex) return nearestVertex

    let nearestEdge = null
    for (const annotation of candidates) {
      annotation.points.forEach((start, index) => {
        const end = annotation.points[(index + 1) % annotation.points.length]
        const a = imageToScreen(start), b = imageToScreen(end)
        const dx = b.x - a.x, dy = b.y - a.y
        const length2 = dx * dx + dy * dy
        if (!length2) return
        const t = Math.max(0, Math.min(1, ((event.clientX - a.x) * dx + (event.clientY - a.y) * dy) / length2))
        const distance = Math.hypot(event.clientX - (a.x + t * dx), event.clientY - (a.y + t * dy))
        if (distance <= snapTolerance && (!nearestEdge || distance < nearestEdge.distance)) {
          nearestEdge = {
            kind: 'edge', annotationId: annotation.id, startVertexId: start.vertexId, endVertexId: end.vertexId,
            t, distance, point: { x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) },
          }
        }
      })
    }
    return nearestEdge
  }

  const selectBoundaryChain = (start, end, event, alternate = false) => {
    const candidates = boundaryChains(topologyAnnotations(), start.vertexId, end.vertexId)
    if (!candidates.length) return null
    const endScreen = imageToScreen(end)
    const scored = candidates.map((candidate) => {
      const previous = candidate.points.length > 1 ? candidate.points[candidate.points.length - 2] : start
      const previousScreen = imageToScreen(previous)
      const dx = previousScreen.x - endScreen.x, dy = previousScreen.y - endScreen.y
      const length = Math.hypot(dx, dy) || 1
      const offsetX = event.clientX - endScreen.x, offsetY = event.clientY - endScreen.y
      const along = (offsetX * dx + offsetY * dy) / length
      const across = Math.abs(offsetX * dy - offsetY * dx) / length
      return { ...candidate, score: across + (along < 0 ? snapTolerance + Math.abs(along) : 0) }
    }).sort((a, b) => a.score - b.score)
    const closest = scored[0]
    if (!alternate) return closest.points
    return scored.find((candidate) => candidate.annotationId === closest.annotationId && candidate.direction !== closest.direction)?.points || scored[1]?.points || closest.points
  }

  const addDraftAction = (points, insertions = []) => {
    setDraft((items) => [...items, ...points])
    if (insertions.length) setDraftInsertions((items) => [...items, ...insertions])
    setDraftActions((items) => [...items, {
      pointCount: points.length,
      insertionVertexIds: [...new Set(insertions.map((item) => item.point.vertexId))],
    }])
    setRouteToggle(false)
    setCursor((current) => current ? { ...current, chain: null, boundary: null } : current)
  }

  const undoDraftAction = () => {
    const action = draftActions[draftActions.length - 1]
    if (!action) return
    setDraft((items) => items.slice(0, -action.pointCount))
    if (action.insertionVertexIds.length) {
      const removed = new Set(action.insertionVertexIds)
      setDraftInsertions((items) => items.filter((item) => !removed.has(item.point.vertexId)))
    }
    setDraftActions((items) => items.slice(0, -1))
    setRouteToggle(false)
    setCursor((current) => current ? { ...current, chain: null, boundary: null } : current)
  }

  const boundaryPreviewCursor = (current, toggled, shiftKey = current?.boundary?.shiftKey) => {
    if (!current?.boundary) return current
    const { start, end, clientX, clientY } = current.boundary
    const chain = selectBoundaryChain(start, end, { clientX, clientY }, Boolean(shiftKey) !== toggled)
    return { ...current, chain, boundary: { ...current.boundary, shiftKey: Boolean(shiftKey) } }
  }

  const finish = useCallback((points, type = tool) => {
    if (!activeLabelId || !points.length) return
    onCommit({ id: createId(), type, labelId: activeLabelId, points, attributes: {}, locked: false, hidden: false, created_at: new Date().toISOString() }, isSegmentation(type) ? draftInsertions : [])
    setDraft([])
    setDraftInsertions([])
    setDraftActions([])
    setRouteToggle(false)
  }, [activeLabelId, draftInsertions, onCommit, tool])

  const confirmFinish = useCallback((points, type = tool) => {
    if (!window.confirm('確定要結束目前的標註嗎？')) return
    finish(points, type)
  }, [finish, tool])

  useEffect(() => {
    const keyHandler = (event) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      if (typing) return
      if (draft.length && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); event.stopImmediatePropagation(); undoDraftAction(); return
      }
      if (draft.length && ['Backspace', 'Delete'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation(); undoDraftAction(); return
      }
      if (draft.length && cursor?.boundary && event.code === 'Space') {
        event.preventDefault(); event.stopImmediatePropagation()
        if (!event.repeat) {
          const next = !routeToggle
          setCursor((cursorState) => boundaryPreviewCursor(cursorState, next))
          setRouteToggle(next)
        }
        return
      }
      if (cursor?.boundary && event.key === 'Shift') setCursor((current) => boundaryPreviewCursor(current, routeToggle, true))
      if (event.key === 'Escape') {
        setDraft([]); setDraftInsertions([]); setDraftActions([]); setRouteToggle(false)
        setCursor((current) => current ? { ...current, chain: null, boundary: null } : current)
      }
      if (event.key === 'Enter' && ['polygon', 'semantic_segmentation', 'instance_segmentation'].includes(tool) && draft.length >= 3) confirmFinish(draft)
    }
    const keyUpHandler = (event) => {
      if (cursor?.boundary && event.key === 'Shift') setCursor((current) => boundaryPreviewCursor(current, routeToggle, false))
      if (cursor?.boundary && ['Control', 'Meta'].includes(event.key)) {
        setCursor((current) => current ? { ...current, chain: null, boundary: null } : current)
        setRouteToggle(false)
      }
    }
    window.addEventListener('keydown', keyHandler)
    window.addEventListener('keyup', keyUpHandler)
    return () => {
      window.removeEventListener('keydown', keyHandler)
      window.removeEventListener('keyup', keyUpHandler)
    }
  }, [confirmFinish, cursor?.boundary, draft, draftActions, routeToggle, tool])

  const hitAnnotations = (point) => visibleAnnotations.filter((item) => {
    const points = annotationPoints(item)
    return pointInPolygon(point, points) || points.some((p, index) => distanceToSegment(point, p, points[(index + 1) % points.length]) < 8 / view.zoom)
  }).sort((a, b) => {
    const area = (item) => {
      const p = annotationPoints(item); return Math.abs(p.reduce((sum, current, i) => sum + current.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * current.y, 0) / 2)
    }
    return area(a) - area(b)
  })

  const selectAt = (point, cycle) => {
    const candidates = hitAnnotations(point)
    if (!candidates.length) { onSelect(null); return null }
    if (!cycle) { onSelect(candidates[0].id); return candidates[0] }
    const sameSpot = Math.hypot(point.x - cycleRef.current.x, point.y - cycleRef.current.y) < 12 / view.zoom
    const next = sameSpot ? (cycleRef.current.index + 1) % candidates.length : 0
    cycleRef.current = { x: point.x, y: point.y, index: next }
    onSelect(candidates[next].id)
    return candidates[next]
  }

  const handlePointerDown = (event) => {
    if (event.button === 2) {
      event.preventDefault()
      const point = screenToImage(event)
      setInteraction({ type: 'pan', clientX: event.clientX, clientY: event.clientY, view, start: point, moved: false })
      svgRef.current.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0) return
    const point = screenToImage(event)
    if (readOnlyGeometry) {
      selectAt(point, event.altKey)
      return
    }
    if (!draft.length && !event.shiftKey) {
      const selected = annotations.find((item) => item.id === selectedId && !item.hidden)
      const selectedPoints = selected ? annotationPoints(selected) : []
      const vertexIndex = selectedPoints.findIndex((vertex) => Math.hypot(vertex.x - point.x, vertex.y - point.y) <= 9 / view.zoom)
      if (selected && !selected.locked && vertexIndex >= 0) {
        setInteraction({ type: 'vertex', item: selected, vertexIndex, start: point, moved: false })
        svgRef.current.setPointerCapture(event.pointerId)
        return
      }
      const target = selectAt(point, event.altKey)
      if (target && !target.locked && !event.altKey) setInteraction({ type: 'move', item: target, start: point, moved: false })
      if (target) {
        svgRef.current.setPointerCapture(event.pointerId)
        return
      }
      setInteraction(null)
    }
    if (!activeLabelId) return
    if (['rectangle', 'reid'].includes(tool)) {
      if (draft.length === 1) finish([draft[0], point]); else addDraftAction([point])
    } else if (tool === 'ocr') {
      const next = [...draft, point]; next.length === 4 ? finish(next) : addDraftAction([point])
    } else if (tool === 'rotated_rectangle') {
      const next = [...draft, point]; next.length === 3 ? finish(rotatedPoints(next[0], next[1], next[2])) : addDraftAction([point])
    } else if (tool === 'polygon') addDraftAction([point])
    else if (isSegmentation(tool)) {
      const snap = findTopologySnap(event)
      const snappedPoint = snap?.kind === 'vertex'
        ? snap.point
        : { ...(snap?.point || point), vertexId: createId() }
      const insertions = snap?.kind === 'edge' ? sharedEdgeInsertions(snap, snappedPoint) : []
      const start = draft[draft.length - 1]
      if ((event.ctrlKey || event.metaKey) && start?.vertexId && snap?.kind === 'vertex') {
        const chain = selectBoundaryChain(start, snappedPoint, event, Boolean(event.shiftKey) !== routeToggle)
        if (chain?.length) { addDraftAction(chain); return }
      }
      addDraftAction([snappedPoint], insertions)
    }
  }

  const handlePointerMove = (event) => {
    const rawPoint = screenToImage(event)
    const snap = isSegmentation(tool) && (draft.length || event.shiftKey) ? findTopologySnap(event) : null
    const start = draft[draft.length - 1]
    const chain = (event.ctrlKey || event.metaKey) && start?.vertexId && snap?.kind === 'vertex'
      ? selectBoundaryChain(start, snap.point, event, Boolean(event.shiftKey) !== routeToggle)
      : null
    const boundary = chain?.length ? { start, end: snap.point, clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey } : null
    setCursor({ ...(snap?.point || rawPoint), snap: snap?.kind || null, chain, boundary })
    if (!interaction) return
    const point = rawPoint
    if (interaction.type === 'pan') {
      const rect = svgRef.current.getBoundingClientRect()
      const dx = (event.clientX - interaction.clientX) * (image.width / rect.width) / view.zoom
      const dy = (event.clientY - interaction.clientY) * (image.height / rect.height) / view.zoom
      if (Math.abs(dx) + Math.abs(dy) > 1) setInteraction((current) => ({ ...current, moved: true }))
      setView({ ...view, x: interaction.view.x - dx, y: interaction.view.y - dy })
      return
    }
    const dx = point.x - interaction.start.x, dy = point.y - interaction.start.y
    if (Math.abs(dx) + Math.abs(dy) > 0.5) setInteraction((current) => ({ ...current, moved: true }))
    const movedPoints = interaction.type === 'move' ? movePoints(interaction.item.points, dx, dy) : editVertex(interaction.item, interaction.vertexIndex, point)
    const points = interaction.item.type === 'reid' ? fitBoxWithinBounds(movedPoints, image.width, image.height) : movedPoints
    const changes = isSegmentation(interaction.item.type)
      ? points.map((nextPoint) => ({ vertexId: nextPoint.vertexId, point: nextPoint }))
      : []
    setDragPreview({ id: interaction.item.id, points, changes })
  }

  const handlePointerUp = (event) => {
    if (dragPreview && interaction?.moved) onUpdate(interaction.item.id, dragPreview.points, dragPreview.changes)
    setInteraction(null)
    setDragPreview(null)
    try { svgRef.current.releasePointerCapture(event.pointerId) } catch { /* noop */ }
  }

  const handleWheel = (event) => {
    event.preventDefault()
    const before = screenToImage(event)
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
    const zoom = Math.max(0.25, Math.min(20, view.zoom * factor))
    const ratio = view.zoom / zoom
    setView({ zoom, x: before.x - (before.x - view.x) * ratio, y: before.y - (before.y - view.y) * ratio })
  }

  const viewBox = `${view.x} ${view.y} ${image.width / view.zoom} ${image.height / view.zoom}`
  const previewPositions = new Map((dragPreview?.changes || []).map(({ vertexId, point }) => [vertexId, point]))
  const renderedAnnotations = visibleAnnotations.map((item) => {
    if (dragPreview?.id === item.id) return { ...item, points: dragPreview.points }
    if (!isSegmentation(item.type) || !previewPositions.size) return item
    return { ...item, points: item.points.map((point) => previewPositions.has(point.vertexId) ? { ...point, ...previewPositions.get(point.vertexId) } : point) }
  })
  const reidInfoLayouts = showReidInfo
    ? layoutReidInfoTags(renderedAnnotations, labels, selectedId, view.zoom, image.width, image.height).sort((first, second) => Number(first.selected) - Number(second.selected))
    : []
  let preview = draft
  let previewIsBox = false
  if (cursor && draft.length) {
    if (tool === 'rotated_rectangle' && draft.length === 2) preview = rotatedPoints(draft[0], draft[1], cursor)
    else if (['rectangle', 'reid'].includes(tool) && draft.length === 1) {
      preview = annotationPoints({ type: 'rectangle', points: [draft[0], cursor] })
      previewIsBox = true
    }
    else preview = cursor.chain?.length ? [...draft, ...cursor.chain] : [...draft, cursor]
  }

  return (
    <div className="canvas-wrap">
      <svg ref={svgRef} className={interaction?.type === 'pan' ? 'panning' : ''} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerLeave={() => { setCursor(null); setRouteToggle(false) }} onContextMenu={(event) => event.preventDefault()} onWheel={handleWheel} onDoubleClick={() => ['polygon', 'semantic_segmentation', 'instance_segmentation'].includes(tool) && draft.length >= 3 && confirmFinish(draft)}>
        {image.mediaType === 'video' ? <foreignObject x="0" y="0" width={image.width || 1280} height={image.height || 720} style={{ pointerEvents: 'none' }}><video ref={videoRef} src={imageUrl} style={{ width: '100%', height: '100%', objectFit: 'contain' }} onLoadedMetadata={(event) => onVideoMetadata?.({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })} onTimeUpdate={(event) => onFrameChange?.(nearestTimelineFrame(frameTimeline, event.currentTarget.currentTime))} /></foreignObject> : <image href={imageUrl} x="0" y="0" width={image.width} height={image.height} />}
        {renderedAnnotations.map((item) => {
          const label = labels.find((candidate) => candidate.id === item.labelId)
          return <Shape key={item.id} item={item} color={label?.color || '#fff'} selected={item.id === selectedId} zoom={view.zoom} readOnlyGeometry={readOnlyGeometry} />
        })}
        {overlayPoints.map((point, index) => <g key={`${point.mmsi}-${index}`} pointerEvents="none"><circle cx={point.x} cy={point.y} r={7 / view.zoom} fill="#22d3ee" stroke="#fff" strokeWidth={2 / view.zoom} vectorEffect="non-scaling-stroke" /><line x1={point.x - 12 / view.zoom} y1={point.y} x2={point.x + 12 / view.zoom} y2={point.y} stroke="#22d3ee" strokeWidth={2 / view.zoom} vectorEffect="non-scaling-stroke" /><line x1={point.x} y1={point.y - 12 / view.zoom} x2={point.x} y2={point.y + 12 / view.zoom} stroke="#22d3ee" strokeWidth={2 / view.zoom} vectorEffect="non-scaling-stroke" /><text x={point.x + 11 / view.zoom} y={point.y - 11 / view.zoom} fill="#fff" stroke="#08111f" strokeWidth={3 / view.zoom} paintOrder="stroke" fontSize={14 / view.zoom} fontWeight="700">{point.mmsi}</text></g>)}
        {reidInfoLayouts.filter((layout) => layout.leader).map((layout) => <g key={`leader-${layout.id}`} pointerEvents="none"><line x1={layout.lineStart.x} y1={layout.lineStart.y} x2={layout.lineEnd.x} y2={layout.lineEnd.y} stroke="#020617" strokeWidth={(layout.selected ? 5.5 : 5) / view.zoom} strokeLinecap="round" opacity=".95" vectorEffect="non-scaling-stroke" /><line x1={layout.lineStart.x} y1={layout.lineStart.y} x2={layout.lineEnd.x} y2={layout.lineEnd.y} stroke={layout.color} strokeWidth={(layout.selected ? 2.75 : 2.25) / view.zoom} strokeLinecap="round" vectorEffect="non-scaling-stroke" /><circle cx={layout.lineStart.x} cy={layout.lineStart.y} r={(layout.selected ? 4 : 3.5) / view.zoom} fill={layout.color} stroke="#020617" strokeWidth={1.5 / view.zoom} vectorEffect="non-scaling-stroke" /></g>)}
        {reidInfoLayouts.map((layout) => <ReidInfoTag key={layout.id} layout={layout} zoom={view.zoom} />)}
        {preview.length > 0 && (previewIsBox ? <polygon className="draft-shape" points={preview.map((p) => `${p.x},${p.y}`).join(' ')} strokeWidth={2 / view.zoom} vectorEffect="non-scaling-stroke" /> : <polyline className={`draft-shape ${cursor?.chain?.length ? 'boundary-chain-preview' : ''}`} points={preview.map((p) => `${p.x},${p.y}`).join(' ')} strokeWidth={2 / view.zoom} vectorEffect="non-scaling-stroke" />)}
        {draft.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={5 / view.zoom} className="vertex draft" />)}
        {cursor?.snap && <circle cx={cursor.x} cy={cursor.y} r={7 / view.zoom} className={`snap-indicator ${cursor.snap}`} strokeWidth={2 / view.zoom} />}
      </svg>
      <div className="zoom-indicator">{Math.round(view.zoom * 100)}%</div>
      {draft.length > 0 && <div className="drawing-hint">{isSegmentation(tool) ? 'Ctrl 預覽沿用邊界，Space 切換路徑，Ctrl 點擊套用，Ctrl+Z 復原草稿' : tool === 'polygon' ? '點擊新增頂點，Enter／雙擊完成，Esc 取消' : tool === 'rotated_rectangle' ? `${draft.length}/3 點` : tool === 'ocr' ? `${draft.length}/4 點` : `${draft.length}/2 點`}</div>}
      {image.mediaType === 'video' && <div className="video-controls"><button onClick={() => { const video = videoRef.current; const timelineIndex = frameTimeline.findIndex((item) => item.frame_index === currentFrame); if (timelineIndex >= 0) video.currentTime = frameTimeline[Math.max(0, timelineIndex - 1)].video_pts_s; else video.currentTime = Math.max(0, video.currentTime - 1 / 30) }}>◀格</button><button onClick={() => videoRef.current?.paused ? videoRef.current.play() : videoRef.current.pause()}>播放／暫停</button><button onClick={() => { const video = videoRef.current; const timelineIndex = frameTimeline.findIndex((item) => item.frame_index === currentFrame); if (timelineIndex >= 0) video.currentTime = frameTimeline[Math.min(frameTimeline.length - 1, timelineIndex + 1)].video_pts_s; else video.currentTime += 1 / 30 }}>格▶</button><span>Frame {currentFrame}</span><input type="range" min="0" max={frameTimeline.length ? frameTimeline.length - 1 : Math.max(1, Math.round((videoRef.current?.duration || 0) * 30))} value={frameTimeline.length ? Math.max(0, frameTimeline.findIndex((item) => item.frame_index === currentFrame)) : currentFrame} onChange={(event) => { const value = Number(event.target.value); const timelineItem = frameTimeline[value]; const frame = timelineItem?.frame_index ?? value; videoRef.current.currentTime = timelineItem?.video_pts_s ?? frame / 30; onFrameChange?.(frame) }} /></div>}
    </div>
  )
}

function ReidInfoTag({ layout, zoom }) {
  const { x, y, width, height, rows, color } = layout
  return <g pointerEvents="none">
    <rect x={x} y={y} width={width} height={height} rx={4 / zoom} fill="#020617" fillOpacity=".88" stroke={color} strokeWidth={1 / zoom} vectorEffect="non-scaling-stroke" />
    <text x={x + 5 / zoom} y={y + 13 / zoom} fill="#f8fafc" fontSize={11 / zoom} fontFamily="'DM Mono', monospace" fontWeight="600">
      {rows.map((row, index) => <tspan key={row} x={x + 5 / zoom} dy={index === 0 ? 0 : 14 / zoom}>{row}</tspan>)}
    </text>
  </g>
}

function Shape({ item, color, selected, zoom, readOnlyGeometry }) {
  const common = { fill: color, fillOpacity: selected ? 0.48 : 0.12, stroke: color, strokeWidth: (selected ? 3 : 2) / zoom, vectorEffect: 'non-scaling-stroke', className: selected ? 'annotation-shape selected' : 'annotation-shape' }
  const points = annotationPoints(item)
  const showVertices = !readOnlyGeometry && (selected || isSegmentation(item.type))
  return <g>{['rectangle', 'reid'].includes(item.type) ? <rect x={Math.min(item.points[0].x, item.points[1].x)} y={Math.min(item.points[0].y, item.points[1].y)} width={Math.abs(item.points[1].x - item.points[0].x)} height={Math.abs(item.points[1].y - item.points[0].y)} {...common} /> : <polygon points={points.map((p) => `${p.x},${p.y}`).join(' ')} {...common} />}{showVertices && points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={4 / zoom} fill="#fff" stroke={color} strokeWidth={2 / zoom} />)}</g>
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

const movePoints = (points, dx, dy) => points.map((point) => ({ x: point.x + dx, y: point.y + dy }))

const editVertex = (item, vertexIndex, point) => {
  if (['rectangle', 'reid'].includes(item.type)) {
    const displayed = annotationPoints(item)
    return [point, displayed[(vertexIndex + 2) % 4]]
  }
  return item.points.map((current, index) => index === vertexIndex ? point : current)
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

export default function AnnotationCanvas({ image, imageUrl, annotations, labels, activeLabelId, tool, selectedId, onSelect, onCommit, onUpdate, resetToken, currentFrame = 0, onFrameChange, readOnlyGeometry = false, frameTimeline = [], onVideoMetadata, overlayPoints = [] }) {
  const svgRef = useRef(null)
  const videoRef = useRef(null)
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const [draft, setDraft] = useState([])
  const [cursor, setCursor] = useState(null)
  const [interaction, setInteraction] = useState(null)
  const [dragPreview, setDragPreview] = useState(null)
  const cycleRef = useRef({ x: 0, y: 0, index: -1 })
  const visibleAnnotations = useMemo(() => annotations.filter((item) => !item.hidden), [annotations])

  useEffect(() => { setView({ x: 0, y: 0, zoom: 1 }); setDraft([]) }, [image.id, resetToken])
  useEffect(() => { setDraft([]) }, [tool])

  const screenToImage = useCallback((event) => {
    const svg = svgRef.current
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY
    const transformed = point.matrixTransform(svg.getScreenCTM().inverse())
    return { x: Math.max(0, Math.min(image.width, transformed.x)), y: Math.max(0, Math.min(image.height, transformed.y)) }
  }, [image.height, image.width])

  const finish = useCallback((points, type = tool) => {
    if (!activeLabelId || !points.length) return
    onCommit({ id: crypto.randomUUID(), type, labelId: activeLabelId, points, attributes: {}, locked: false, hidden: false, created_at: new Date().toISOString() })
    setDraft([])
  }, [activeLabelId, onCommit, tool])

  useEffect(() => {
    const keyHandler = (event) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      if (typing) return
      if (event.key === 'Escape') setDraft([])
      if (event.key === 'Enter' && ['polygon', 'semantic_segmentation', 'instance_segmentation'].includes(tool) && draft.length >= 3) finish(draft)
      if (event.key === 'Backspace' && draft.length) { event.preventDefault(); setDraft((items) => items.slice(0, -1)) }
    }
    window.addEventListener('keydown', keyHandler)
    return () => window.removeEventListener('keydown', keyHandler)
  }, [draft, finish, tool])

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
      if (draft.length === 1) finish([draft[0], point]); else setDraft([point])
    } else if (tool === 'ocr') {
      const next = [...draft, point]; next.length === 4 ? finish(next) : setDraft(next)
    } else if (tool === 'rotated_rectangle') {
      const next = [...draft, point]; next.length === 3 ? finish(rotatedPoints(next[0], next[1], next[2])) : setDraft(next)
    } else if (['polygon', 'semantic_segmentation', 'instance_segmentation'].includes(tool)) setDraft((items) => [...items, point])
  }

  const handlePointerMove = (event) => {
    setCursor(screenToImage(event))
    if (!interaction) return
    const point = screenToImage(event)
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
    const points = interaction.type === 'move' ? movePoints(interaction.item.points, dx, dy) : editVertex(interaction.item, interaction.vertexIndex, point)
    setDragPreview({ id: interaction.item.id, points })
  }

  const handlePointerUp = (event) => {
    if (dragPreview && interaction?.moved) onUpdate(interaction.item.id, dragPreview.points)
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
  const renderedAnnotations = visibleAnnotations.map((item) => dragPreview?.id === item.id ? { ...item, points: dragPreview.points } : item)
  let preview = draft
  let previewIsBox = false
  if (cursor && draft.length) {
    if (tool === 'rotated_rectangle' && draft.length === 2) preview = rotatedPoints(draft[0], draft[1], cursor)
    else if (['rectangle', 'reid'].includes(tool) && draft.length === 1) {
      preview = annotationPoints({ type: 'rectangle', points: [draft[0], cursor] })
      previewIsBox = true
    }
    else preview = [...draft, cursor]
  }

  return (
    <div className="canvas-wrap">
      <svg ref={svgRef} className={interaction?.type === 'pan' ? 'panning' : ''} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerLeave={() => setCursor(null)} onContextMenu={(event) => event.preventDefault()} onWheel={handleWheel} onDoubleClick={() => ['polygon', 'semantic_segmentation', 'instance_segmentation'].includes(tool) && draft.length >= 3 && finish(draft)}>
        {image.mediaType === 'video' ? <foreignObject x="0" y="0" width={image.width || 1280} height={image.height || 720} style={{ pointerEvents: 'none' }}><video ref={videoRef} src={imageUrl} style={{ width: '100%', height: '100%', objectFit: 'contain' }} onLoadedMetadata={(event) => onVideoMetadata?.({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })} onTimeUpdate={(event) => onFrameChange?.(nearestTimelineFrame(frameTimeline, event.currentTarget.currentTime))} /></foreignObject> : <image href={imageUrl} x="0" y="0" width={image.width} height={image.height} />}
        {renderedAnnotations.map((item) => <Shape key={item.id} item={item} color={labels.find((label) => label.id === item.labelId)?.color || '#fff'} selected={item.id === selectedId} zoom={view.zoom} readOnlyGeometry={readOnlyGeometry} />)}
        {overlayPoints.map((point, index) => <g key={`${point.mmsi}-${index}`} pointerEvents="none"><circle cx={point.x} cy={point.y} r={7 / view.zoom} fill="#22d3ee" stroke="#fff" strokeWidth={2 / view.zoom} vectorEffect="non-scaling-stroke" /><line x1={point.x - 12 / view.zoom} y1={point.y} x2={point.x + 12 / view.zoom} y2={point.y} stroke="#22d3ee" strokeWidth={2 / view.zoom} vectorEffect="non-scaling-stroke" /><line x1={point.x} y1={point.y - 12 / view.zoom} x2={point.x} y2={point.y + 12 / view.zoom} stroke="#22d3ee" strokeWidth={2 / view.zoom} vectorEffect="non-scaling-stroke" /><text x={point.x + 11 / view.zoom} y={point.y - 11 / view.zoom} fill="#fff" stroke="#08111f" strokeWidth={3 / view.zoom} paintOrder="stroke" fontSize={14 / view.zoom} fontWeight="700">{point.mmsi}</text></g>)}
        {preview.length > 0 && (previewIsBox ? <polygon className="draft-shape" points={preview.map((p) => `${p.x},${p.y}`).join(' ')} strokeWidth={2 / view.zoom} vectorEffect="non-scaling-stroke" /> : <polyline className="draft-shape" points={preview.map((p) => `${p.x},${p.y}`).join(' ')} strokeWidth={2 / view.zoom} vectorEffect="non-scaling-stroke" />)}
        {draft.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={5 / view.zoom} className="vertex draft" />)}
      </svg>
      <div className="zoom-indicator">{Math.round(view.zoom * 100)}%</div>
      {draft.length > 0 && <div className="drawing-hint">{['polygon', 'semantic_segmentation', 'instance_segmentation'].includes(tool) ? '點擊新增頂點，Enter／雙擊完成，Esc 取消' : tool === 'rotated_rectangle' ? `${draft.length}/3 點` : tool === 'ocr' ? `${draft.length}/4 點` : `${draft.length}/2 點`}</div>}
      {image.mediaType === 'video' && <div className="video-controls"><button onClick={() => { const video = videoRef.current; const timelineIndex = frameTimeline.findIndex((item) => item.frame_index === currentFrame); if (timelineIndex >= 0) video.currentTime = frameTimeline[Math.max(0, timelineIndex - 1)].video_pts_s; else video.currentTime = Math.max(0, video.currentTime - 1 / 30) }}>◀格</button><button onClick={() => videoRef.current?.paused ? videoRef.current.play() : videoRef.current.pause()}>播放／暫停</button><button onClick={() => { const video = videoRef.current; const timelineIndex = frameTimeline.findIndex((item) => item.frame_index === currentFrame); if (timelineIndex >= 0) video.currentTime = frameTimeline[Math.min(frameTimeline.length - 1, timelineIndex + 1)].video_pts_s; else video.currentTime += 1 / 30 }}>格▶</button><span>Frame {currentFrame}</span><input type="range" min="0" max={frameTimeline.length ? frameTimeline.length - 1 : Math.max(1, Math.round((videoRef.current?.duration || 0) * 30))} value={frameTimeline.length ? Math.max(0, frameTimeline.findIndex((item) => item.frame_index === currentFrame)) : currentFrame} onChange={(event) => { const value = Number(event.target.value); const timelineItem = frameTimeline[value]; const frame = timelineItem?.frame_index ?? value; videoRef.current.currentTime = timelineItem?.video_pts_s ?? frame / 30; onFrameChange?.(frame) }} /></div>}
    </div>
  )
}

function Shape({ item, color, selected, zoom, readOnlyGeometry }) {
  const common = { fill: color, fillOpacity: selected ? 0.24 : 0.12, stroke: color, strokeWidth: (selected ? 3 : 2) / zoom, vectorEffect: 'non-scaling-stroke', className: selected ? 'annotation-shape selected' : 'annotation-shape' }
  const points = annotationPoints(item)
  return <g>{['rectangle', 'reid'].includes(item.type) ? <rect x={Math.min(item.points[0].x, item.points[1].x)} y={Math.min(item.points[0].y, item.points[1].y)} width={Math.abs(item.points[1].x - item.points[0].x)} height={Math.abs(item.points[1].y - item.points[0].y)} {...common} /> : <polygon points={points.map((p) => `${p.x},${p.y}`).join(' ')} {...common} />}{selected && !readOnlyGeometry && points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={4 / zoom} fill="#fff" stroke={color} strokeWidth={2 / zoom} />)}</g>
}

import { createId } from './uuid.js'

export const SEGMENTATION_TYPES = new Set(['semantic_segmentation', 'instance_segmentation'])
export const isSegmentation = (type) => SEGMENTATION_TYPES.has(type)

const coordinateKey = (point) => `${point.x}\u0000${point.y}`

export function hydrateSegmentationTopology(annotations) {
  const vertices = new Map()
  return annotations.map((annotation) => {
    if (!isSegmentation(annotation.type)) return annotation
    const points = annotation.points.map((point) => {
      if (point.vertexId) {
        vertices.set(coordinateKey(point), point.vertexId)
        return point
      }
      const key = coordinateKey(point)
      const vertexId = vertices.get(key) || createId()
      vertices.set(key, vertexId)
      return { ...point, vertexId }
    })
    return { ...annotation, points }
  })
}

export function insertSharedVertices(annotations, insertions) {
  if (!insertions.length) return annotations
  let result = annotations
  for (const insertion of insertions) {
    result = result.map((annotation) => {
      if (annotation.id !== insertion.annotationId || !isSegmentation(annotation.type)) return annotation
      if (annotation.points.some((point) => point.vertexId === insertion.point.vertexId)) return annotation
      const edgeIndex = annotation.points.findIndex((point, index) => (
        point.vertexId === insertion.startVertexId
        && annotation.points[(index + 1) % annotation.points.length].vertexId === insertion.endVertexId
      ))
      if (edgeIndex < 0) return annotation
      const points = [...annotation.points]
      points.splice(edgeIndex + 1, 0, insertion.point)
      return { ...annotation, points }
    })
  }
  return result
}

export function updateSharedVertices(annotations, annotationId, points, changes = []) {
  if (!changes.length) return annotations.map((annotation) => annotation.id === annotationId ? { ...annotation, points } : annotation)
  const positions = new Map(changes.map(({ vertexId, point }) => [vertexId, point]))
  return annotations.map((annotation) => {
    if (!isSegmentation(annotation.type)) return annotation.id === annotationId ? { ...annotation, points } : annotation
    let changed = false
    const nextPoints = annotation.points.map((point) => {
      const position = positions.get(point.vertexId)
      if (!position) return point
      changed = true
      return { ...point, x: position.x, y: position.y }
    })
    return changed ? { ...annotation, points: nextPoints } : annotation
  })
}

export function boundaryChains(annotations, startVertexId, endVertexId) {
  const chains = []
  for (const annotation of annotations) {
    if (!isSegmentation(annotation.type)) continue
    const start = annotation.points.findIndex((point) => point.vertexId === startVertexId)
    const end = annotation.points.findIndex((point) => point.vertexId === endVertexId)
    if (start < 0 || end < 0 || start === end) continue
    const forward = []
    for (let index = (start + 1) % annotation.points.length; ; index = (index + 1) % annotation.points.length) {
      forward.push(annotation.points[index])
      if (index === end) break
    }
    const backward = []
    for (let index = (start - 1 + annotation.points.length) % annotation.points.length; ; index = (index - 1 + annotation.points.length) % annotation.points.length) {
      backward.push(annotation.points[index])
      if (index === end) break
    }
    chains.push({ annotationId: annotation.id, direction: 'forward', points: forward })
    chains.push({ annotationId: annotation.id, direction: 'backward', points: backward })
  }
  return chains
}

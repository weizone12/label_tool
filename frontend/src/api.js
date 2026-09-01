async function request(path, options = {}) {
  const response = await fetch(path, options)
  if (!response.ok) {
    let message = `請求失敗（${response.status}）`
    try { message = (await response.json()).error || message } catch { /* noop */ }
    throw new Error(message)
  }
  if (response.status === 204) return null
  return response.json()
}

const geometryPoints = (annotation) => {
  const geometry = annotation.geometry || {}
  if (['rectangle', 'reid'].includes(annotation.mode)) return [
    { x: geometry.x || 0, y: geometry.y || 0 },
    { x: (geometry.x || 0) + (geometry.width || 0), y: (geometry.y || 0) + (geometry.height || 0) },
  ]
  const points = ['polygon', 'semantic_segmentation', 'instance_segmentation'].includes(annotation.mode)
    ? geometry.polygons?.[0] || []
    : geometry.points || []
  return points.map(([x, y]) => ({ x, y }))
}

const toEditorAnnotation = (annotation) => ({
  id: annotation.id,
  type: annotation.mode,
  labelId: annotation.label_id,
  points: geometryPoints(annotation),
  attributes: annotation.attributes || {},
  ...(annotation.metadata || {}),
  ...(['reid'].includes(annotation.mode) ? {
    identity_id: annotation.identity_id,
    track_id: annotation.track_id,
    camera_id: annotation.camera_id,
    video_id: annotation.video_id,
    frame_id: annotation.frame_id,
  } : {}),
})

const toStoredAnnotation = (annotation) => {
  const points = annotation.points || []
  let geometry
  if (['rectangle', 'reid'].includes(annotation.type)) {
    const [a = { x: 0, y: 0 }, b = a] = points
    geometry = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
  } else if (['polygon', 'semantic_segmentation', 'instance_segmentation'].includes(annotation.type)) {
    geometry = { polygons: [points.map(({ x, y }) => [x, y])] }
  } else {
    geometry = { points: points.map(({ x, y }) => [x, y]) }
  }
  const metadata = { ...(annotation.metadata || {}) }
  for (const key of ['hidden', 'locked', 'created_at', 'keyframe']) {
    if (annotation[key] !== undefined) metadata[key] = annotation[key]
  }
  const stored = { id: annotation.id, mode: annotation.type, label_id: annotation.labelId, geometry, attributes: annotation.attributes || {}, metadata }
  if (annotation.type === 'reid') {
    stored.identity_id = annotation.identity_id ?? ''
    stored.track_id = annotation.track_id || null
    stored.camera_id = annotation.camera_id || null
    stored.video_id = annotation.video_id || null
    stored.frame_id = annotation.frame_id ?? null
    for (const key of ['identity_id', 'track_id', 'camera_id', 'video_id', 'frame_id']) delete stored.metadata[key]
  }
  return stored
}

const toEditorDocument = (document) => ({ ...document, annotations: (document.annotations || []).map(toEditorAnnotation) })

const toStoredDocument = (document) => ({ ...document, annotations: (document.annotations || []).map(toStoredAnnotation) })

export const api = {
  listProjects: () => request('/api/projects'),
  createProject: (data) => request('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }),
  updateProject: (id, data) => request(`/api/projects/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }),
  deleteProject: (id) => request(`/api/projects/${id}`, { method: 'DELETE' }),
  listImages: (id) => request(`/api/projects/${id}/images`),
  selectImageFiles: (id) => request(`/api/projects/${id}/images/select-files`, { method: 'POST' }),
  selectImageFolder: (id) => request(`/api/projects/${id}/images/select-folder`, { method: 'POST' }),
  registerImagePaths: (id, paths, root) => request(`/api/projects/${id}/images/register-paths`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths, root }),
  }),
  uploadImages: async (id, files, onProgress) => {
    const fileArray = Array.from(files)
    const batchSize = 100 // 每批 100 張
    const totalFiles = fileArray.length
    let uploadedCount = 0
    let lastResult = null

    for (let i = 0; i < totalFiles; i += batchSize) {
      const chunk = fileArray.slice(i, i + batchSize)
      const body = new FormData()
      chunk.forEach((file) => body.append('files', file, file.webkitRelativePath || file.name))

      lastResult = await request(`/api/projects/${id}/images`, {
        method: 'POST',
        body,
      })

      uploadedCount += chunk.length
      
      // 每一批上傳成功後，回報當前進度
      if (onProgress) {
        onProgress(uploadedCount, totalFiles)
      }
    }

    return lastResult
  },
  getAnnotation: async (projectId, imageId) => toEditorDocument(await request(`/api/projects/${projectId}/images/${imageId}/annotation`)),
  saveAnnotation: async (projectId, imageId, data) => toEditorDocument(await request(`/api/projects/${projectId}/images/${imageId}/annotation`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toStoredDocument(data)),
  })),
  imageUrl: (projectId, imageId) => `/api/projects/${projectId}/images/${imageId}/content`,
}

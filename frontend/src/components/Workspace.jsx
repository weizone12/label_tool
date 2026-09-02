import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Eye, EyeOff, FolderOpen, ImagePlus, Lock, Pencil, RotateCcw, Save, Trash2, Unlock, X } from 'lucide-react'
import { api } from '../api'
import AnnotationCanvas from './AnnotationCanvas'

const TOOL_NAMES = {
  rectangle: '矩形', polygon: '多邊形', ocr: 'OCR 四邊形', rotated_rectangle: '三點旋轉矩形',
  semantic_segmentation: '語意分割區域', instance_segmentation: '實例分割區域', reid: 'ReID 人物框', classification: '圖片分類',
}
const LABEL_COLORS = ['#fb7185', '#f59e0b', '#84cc16', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899']

const interpolateReidPoints = (before, after, ratio) => {
  const box = (item) => ({
    centerX: (item.points[0].x + item.points[1].x) / 2,
    centerY: (item.points[0].y + item.points[1].y) / 2,
    width: Math.abs(item.points[1].x - item.points[0].x),
    height: Math.abs(item.points[1].y - item.points[0].y),
  })
  const beforeBox = box(before), afterBox = box(after)
  const widthChange = beforeBox.width ? Math.abs(afterBox.width - beforeBox.width) / beforeBox.width : Infinity
  const heightChange = beforeBox.height ? Math.abs(afterBox.height - beforeBox.height) / beforeBox.height : Infinity
  if (widthChange <= 0.05 && heightChange <= 0.05) {
    const centerX = beforeBox.centerX + (afterBox.centerX - beforeBox.centerX) * ratio
    const centerY = beforeBox.centerY + (afterBox.centerY - beforeBox.centerY) * ratio
    const width = (beforeBox.width + afterBox.width) / 2
    const height = (beforeBox.height + afterBox.height) / 2
    return [{ x: centerX - width / 2, y: centerY - height / 2 }, { x: centerX + width / 2, y: centerY + height / 2 }]
  }
  return before.points.map((point, index) => ({ x: point.x + (after.points[index].x - point.x) * ratio, y: point.y + (after.points[index].y - point.y) * ratio }))
}

const regenerateReidAnnotations = (annotations) => {
  const protectedAnnotations = annotations.filter((item) => item.type !== 'reid' || item.generated !== true)
  const existingGenerated = new Map(annotations.filter((item) => item.type === 'reid' && item.generated === true).map((item) => [`${item.track_id}:${item.frame_id}`, item]))
  const tracks = new Map()
  protectedAnnotations.filter((item) => item.type === 'reid' && item.keyframe === true && item.track_id && Number.isInteger(item.frame_id)).forEach((item) => {
    if (!tracks.has(item.track_id)) tracks.set(item.track_id, [])
    tracks.get(item.track_id).push(item)
  })
  const occupied = new Set(protectedAnnotations.filter((item) => item.type === 'reid' && item.track_id && Number.isInteger(item.frame_id)).map((item) => `${item.track_id}:${item.frame_id}`))
  const generated = []
  tracks.forEach((items, trackId) => {
    items.sort((a, b) => a.frame_id - b.frame_id)
    for (let index = 0; index < items.length - 1; index += 1) {
      const before = items[index], after = items[index + 1]
      if (before.points.length !== 2 || after.points.length !== 2) continue
      for (let frame = before.frame_id + 1; frame < after.frame_id; frame += 1) {
        const key = `${trackId}:${frame}`
        if (occupied.has(key)) continue
        const previous = existingGenerated.get(key)
        generated.push({
          ...before,
          id: previous?.id || crypto.randomUUID(),
          points: interpolateReidPoints(before, after, (frame - before.frame_id) / (after.frame_id - before.frame_id)),
          frame_id: frame,
          keyframe: false,
          generated: true,
          interpolated: false,
          locked: false,
          created_at: previous?.created_at || new Date().toISOString(),
        })
      }
    }
  })
  return [...protectedAnnotations, ...generated].sort((a, b) => (a.frame_id ?? -1) - (b.frame_id ?? -1))
}

const annotationsAtFrame = (annotations, frame) => annotations.filter((item) => item.frame_id === frame)

export default function Workspace({ project: initialProject, onExit }) {
  const [project, setProject] = useState(initialProject)
  const [images, setImages] = useState([])
  const [index, setIndex] = useState(0)
  const [document, setDocument] = useState({ annotations: [], classifications: [], revision: 0 })
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [activeLabelId, setActiveLabelId] = useState(project.labels[0]?.id || '')
  const tool = project.primaryMode
  const [saveState, setSaveState] = useState('已儲存')
  const [resetToken, setResetToken] = useState(0)
  const [error, setError] = useState('')
  const [currentFrame, setCurrentFrame] = useState(0)
  const [progressFilter, setProgressFilter] = useState('all')
  const [newLabelName, setNewLabelName] = useState('')
  const [addingLabel, setAddingLabel] = useState(false)
  const [editingLabelId, setEditingLabelId] = useState(null)
  const [editingLabelName, setEditingLabelName] = useState('')
  const [renamingLabel, setRenamingLabel] = useState(false)
  const [newAttributeName, setNewAttributeName] = useState('')
  const [newAttributeType, setNewAttributeType] = useState('text')
  const [addingAttribute, setAddingAttribute] = useState(false)
  const [deletingDefinition, setDeletingDefinition] = useState('')
  
  // 👇 新增：上傳狀態與進度
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 })

  const saveTimer = useRef(null)
  const finishInProgress = useRef(false)
  const ocrInputRef = useRef(null)
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)
  const filteredImages = images.filter((item) => progressFilter === 'all' || (progressFilter === 'completed' ? item.completed : !item.completed))
  const currentImage = filteredImages[index] || filteredImages[0]

  const loadImages = useCallback(async () => {
    try {
      const list = await api.listImages(project.id)
      // 依原始檔名（或 filename）進行自然數字排序
      const sorted = [...list].sort((a, b) => {
        const nameA = a.originalFilename || a.filename || ''
        const nameB = b.originalFilename || b.filename || ''
        return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' })
      })
      setImages(sorted)
    } catch (err) {
      setError(err.message)
    }
  }, [project.id])
  useEffect(() => { loadImages() }, [loadImages])

  useEffect(() => {
    if (!currentImage) { setDocument({ annotations: [], classifications: [], revision: 0 }); return }
    let cancelled = false
    api.getAnnotation(project.id, currentImage.id).then((data) => {
      if (cancelled) return
      const annotations = project.primaryMode === 'reid' && currentImage.mediaType === 'video' ? regenerateReidAnnotations(data.annotations) : data.annotations
      const materialized = { ...data, annotations }
      setDocument(materialized); setPast([]); setFuture([]); setSelectedId(null); setCurrentFrame(0); setSaveState('已儲存')
      if (JSON.stringify(annotations) !== JSON.stringify(data.annotations)) {
        api.saveAnnotation(project.id, currentImage.id, materialized).then((saved) => {
          if (!cancelled) setDocument((current) => ({ ...current, revision: saved.revision, updatedAt: saved.updatedAt }))
        }).catch((err) => { if (!cancelled) setError(err.message) })
      }
    }).catch((err) => setError(err.message))
    return () => { cancelled = true }
  }, [project.id, project.primaryMode, currentImage?.id, currentImage?.mediaType])

  const save = useCallback(async (payload = document) => {
    if (!currentImage) return null
    clearTimeout(saveTimer.current)
    setSaveState('儲存中…')
    try {
      const saved = await api.saveAnnotation(project.id, currentImage.id, payload)
      setDocument((current) => ({ ...current, revision: saved.revision, updatedAt: saved.updatedAt }))
      setSaveState('已儲存')
      return saved
    } catch (err) { setSaveState('儲存失敗'); setError(err.message); return null }
  }, [currentImage, document, project.id])

  const commit = useCallback((next) => {
    setDocument((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      setPast((items) => [...items.slice(-49), current])
      setFuture([])
      setSaveState('尚未儲存')
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => save(resolved), 700)
      return resolved
    })
  }, [save])

  const undo = useCallback(() => {
    setPast((items) => {
      if (!items.length) return items
      const previous = items[items.length - 1]
      setFuture((next) => [document, ...next])
      setDocument(previous); setSaveState('尚未儲存')
      clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => save(previous), 700)
      return items.slice(0, -1)
    })
  }, [document, save])
  
  const redo = useCallback(() => {
    setFuture((items) => {
      if (!items.length) return items
      const next = items[0]
      setPast((previous) => [...previous, document])
      setDocument(next); setSaveState('尚未儲存')
      clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => save(next), 700)
      return items.slice(1)
    })
  }, [document, save])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    commit((current) => {
      const annotations = current.annotations.filter((item) => item.id !== selectedId)
      return { ...current, annotations: tool === 'reid' ? regenerateReidAnnotations(annotations) : annotations }
    })
    setSelectedId(null)
  }, [commit, selectedId, tool])

  const navigate = useCallback((delta) => {
    if (!filteredImages.length) return
    if (saveState === '尚未儲存') save()
    setIndex((value) => Math.max(0, Math.min(filteredImages.length - 1, value + delta)))
  }, [filteredImages.length, save, saveState])

  const finishAndNext = useCallback(async () => {
    if (!currentImage || finishInProgress.current) return
    finishInProgress.current = true
    try {
      const completedDocument = { ...document, completed: true }
      const saved = await save(completedDocument)
      if (!saved) return
      setDocument((current) => ({ ...current, completed: true, revision: saved.revision, updatedAt: saved.updatedAt }))
      setImages((items) => items.map((item) => item.id === currentImage.id ? { ...item, completed: true } : item))
      if (progressFilter === 'pending') {
        const remaining = filteredImages.filter((item) => item.id !== currentImage.id).length
        setIndex((value) => Math.min(value, Math.max(0, remaining - 1)))
      } else {
        setIndex((value) => Math.min(value + 1, Math.max(0, filteredImages.length - 1)))
      }
    } finally {
      finishInProgress.current = false
    }
  }, [currentImage, document, filteredImages, progressFilter, save])

  useEffect(() => {
    const handler = (event) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(window.document.activeElement?.tagName)
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return }
      if (typing) return
      if (['Backspace', 'Delete'].includes(event.key)) { event.preventDefault(); deleteSelected() }
      else if (['a', 'A', 'ArrowLeft'].includes(event.key)) navigate(-1)
      else if (['d', 'D', 'ArrowRight'].includes(event.key)) navigate(1)
      else if (['r', 'R'].includes(event.key)) setResetToken((value) => value + 1)
      else if (['f', 'F'].includes(event.key) && !event.repeat) { event.preventDefault(); finishAndNext() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [deleteSelected, finishAndNext, navigate, redo, undo])

  const selected = document.annotations.find((item) => item.id === selectedId)
  const selectedLabel = project.labels.find((label) => label.id === selected?.labelId)
  const updateSelected = (patch) => commit((current) => {
    const annotations = current.annotations.map((item) => item.id === selectedId
      ? { ...item, ...patch, ...(item.type === 'reid' && item.generated === true ? { keyframe: true, generated: false } : {}) }
      : item)
    return { ...current, annotations: tool === 'reid' ? regenerateReidAnnotations(annotations) : annotations }
  })

  useEffect(() => {
    if (selected?.type === 'ocr') setTimeout(() => ocrInputRef.current?.focus(), 0)
  }, [selectedId, selected?.type])

  // 👇 修改：加入進度回報邏輯
  const upload = async (files) => {
    if (!files?.length) return
    setUploading(true)
    setUploadProgress({ current: 0, total: files.length })
    try { 
      // 這裡傳入 callback 給 api.js 接收進度
      await api.uploadImages(project.id, files, (current, total) => {
        setUploadProgress({ current, total })
      })
      await loadImages() 
    } catch (err) { 
      setError(err.message) 
    } finally {
      setUploading(false)
    }
  }

  const handleUpload = async (event) => {
    await upload(event.target.files)
    event.target.value = ''
  }

  const toggleClassification = (labelId) => commit((current) => {
    const selected = current.classifications.some((item) => item.label_id === labelId)
    const classifications = project.classificationMode === 'single'
      ? (selected ? [] : [{ label_id: labelId }])
      : (selected ? current.classifications.filter((item) => item.label_id !== labelId) : [...current.classifications, { label_id: labelId }])
    return { ...current, classifications }
  })

  const handleCanvasCommit = (annotation) => {
    const enriched = {
      ...annotation,
      ...(currentImage?.mediaType === 'video' ? { frame_id: currentFrame, keyframe: true } : {}),
      ...(tool === 'reid' ? { identity_id: '', track_id: null, camera_id: null, video_id: null, frame_id: currentImage?.mediaType === 'video' ? currentFrame : null } : {}),
    }
    commit((current) => {
      const annotations = [...current.annotations, enriched]
      return { ...current, annotations: tool === 'reid' ? regenerateReidAnnotations(annotations) : annotations }
    })
    setSelectedId(enriched.id)
  }

  const classificationLabels = project.labels.filter((label) => !label.system)
  const activeLabel = project.labels.find((label) => label.id === activeLabelId)
  const visibleAnnotations = currentImage?.mediaType === 'video' ? annotationsAtFrame(document.annotations, currentFrame) : document.annotations

  const addLabel = async () => {
    const name = newLabelName.trim()
    if (!name || addingLabel) return
    if (project.labels.some((label) => label.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setError(`Label「${name}」已存在`)
      return
    }
    setAddingLabel(true)
    try {
      const baseId = name.toLocaleLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^[-_]+|[-_]+$/g, '') || 'label'
      let classificationId = baseId
      let suffix = 2
      while (project.labels.some((item) => item.id === classificationId)) classificationId = `${baseId}-${suffix++}`
      const label = {
        id: classificationId,
        name,
        color: LABEL_COLORS[project.labels.filter((item) => !item.system).length % LABEL_COLORS.length],
        attributes: [],
      }
      const updated = await api.updateProject(project.id, { labels: [...project.labels, label] })
      setProject(updated)
      setActiveLabelId(label.id)
      setNewLabelName('')
    } catch (err) {
      setError(err.message)
    } finally {
      setAddingLabel(false)
    }
  }

  const renameLabel = async () => {
    const name = editingLabelName.trim()
    if (!editingLabelId || !name || renamingLabel) return
    if (project.labels.some((label) => label.id !== editingLabelId && label.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setError(`Label「${name}」已存在`)
      return
    }
    setRenamingLabel(true)
    try {
      const labels = project.labels.map((label) => label.id === editingLabelId ? { ...label, name } : label)
      const updated = await api.updateProject(project.id, { labels })
      setProject(updated)
      setEditingLabelId(null)
      setEditingLabelName('')
    } catch (err) {
      setError(err.message)
    } finally {
      setRenamingLabel(false)
    }
  }

  const addAttribute = async () => {
    const name = newAttributeName.trim()
    if (!activeLabel || !name || addingAttribute) return
    if ((activeLabel.attributes || []).some((attribute) => attribute.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setError(`Label「${activeLabel.name}」已有屬性「${name}」`)
      return
    }
    setAddingAttribute(true)
    try {
      const attribute = { id: crypto.randomUUID(), name, type: newAttributeType }
      const labels = project.labels.map((label) => label.id === activeLabel.id
        ? { ...label, attributes: [...(label.attributes || []), attribute] }
        : label)
      const updated = await api.updateProject(project.id, { labels })
      setProject(updated)
      setNewAttributeName('')
      setNewAttributeType('text')
    } catch (err) {
      setError(err.message)
    } finally {
      setAddingAttribute(false)
    }
  }

  const deleteLabel = async (label) => {
    if (deletingDefinition || !confirm(`確定刪除未使用的 label「${label.name}」？`)) return
    setDeletingDefinition(`label:${label.id}`)
    try {
      if (currentImage && !(await save())) return
      const labels = project.labels.filter((item) => item.id !== label.id)
      const updated = await api.updateProject(project.id, { labels })
      setProject(updated)
      if (activeLabelId === label.id) setActiveLabelId(labels.find((item) => !item.system)?.id || '')
    } catch (err) {
      setError(err.message)
    } finally {
      setDeletingDefinition('')
    }
  }

  const deleteAttribute = async (attribute) => {
    if (!activeLabel || deletingDefinition || !confirm(`確定刪除未使用的屬性「${attribute.name}」？`)) return
    setDeletingDefinition(`attribute:${attribute.id}`)
    try {
      if (currentImage && !(await save())) return
      const labels = project.labels.map((label) => label.id === activeLabel.id
        ? { ...label, attributes: (label.attributes || []).filter((item) => item.id !== attribute.id) }
        : label)
      const updated = await api.updateProject(project.id, { labels })
      setProject(updated)
    } catch (err) {
      setError(err.message)
    } finally {
      setDeletingDefinition('')
    }
  }

  const toggleCompleted = () => {
    const next = { ...document, completed: !document.completed }
    commit(next)
    setImages((items) => items.map((item) => item.id === currentImage.id ? { ...item, completed: next.completed } : item))
  }

  return (
    <main className="workspace-shell">
      <input ref={fileInputRef} className="hidden-file-input" type="file" multiple accept={project.primaryMode === 'reid' ? 'image/*,video/*' : 'image/*'} onChange={handleUpload} />
      <input ref={folderInputRef} className="hidden-file-input" type="file" multiple webkitdirectory="" directory="" onChange={handleUpload} />
      {/* 👇 新增：上傳進度遮罩 */}
      {uploading && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 9999, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--panel-bg, #fff)', color: 'var(--text-primary, #000)', padding: '24px', borderRadius: '12px', width: '320px', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: '16px' }}>圖片載入中...</h3>
            {uploadProgress.total > 0 ? <><div style={{ fontSize: '14px', marginBottom: '12px' }}>已複製：{uploadProgress.current} / {uploadProgress.total} 個檔案</div><progress value={uploadProgress.current} max={uploadProgress.total} style={{ width: '100%', height: '8px' }} /></> : <div style={{ fontSize: '14px' }}>請在 Windows 視窗中選擇圖片或資料夾</div>}
          </div>
        </div>
      )}

      <header className="workspace-header">
        <div className="workspace-brand"><button className="icon-button" onClick={(event) => { event.stopPropagation(); onExit() }}><ArrowLeft size={19} /></button><div><strong>{project.name}</strong><span>{currentImage ? `${index + 1} / ${images.length} · ${currentImage.filename}` : '尚未載入圖片'}</span></div></div>
        <div className="workspace-actions">
          <select className="progress-filter" value={progressFilter} onChange={(event) => { setProgressFilter(event.target.value); setIndex(0) }}><option value="all">全部資料</option><option value="pending">未完成</option><option value="completed">已完成</option></select>
          {filteredImages.length > 0 && <label className="image-jump"><span>跳轉資料</span><select value={Math.max(0, filteredImages.findIndex((item) => item.id === currentImage?.id))} onChange={(event) => setIndex(Number(event.target.value))}>{filteredImages.map((item, imageIndex) => <option key={item.id} value={imageIndex}>{imageIndex + 1}. {item.originalFilename || item.filename}</option>)}</select></label>}
          <button className="secondary-button compact" onClick={toggleCompleted} disabled={!currentImage}>{document.completed ? '取消完成' : '標記完成'}</button>
          <button className="secondary-button compact" onClick={() => fileInputRef.current?.click()} disabled={uploading}><ImagePlus size={16} />新增圖片</button>
          <button className="secondary-button compact" onClick={() => folderInputRef.current?.click()} disabled={uploading}><FolderOpen size={16} />選擇資料夾</button>
          <div className="save-status"><span className={`status-dot ${saveState === '儲存失敗' ? 'failed' : ''}`} />{saveState}<button className="secondary-button compact" onClick={() => save()} disabled={!currentImage}><Save size={16} />手動儲存</button></div>
        </div>
      </header>
      {error && <div className="error-banner workspace-error" onClick={() => setError('')}>{error}（點擊關閉）</div>}
      <div className="workspace-grid">
        <aside className="tool-panel">
          <span className="panel-label">工具</span>
          <button className="tool-button active">{tool === 'rectangle' ? '▭' : tool === 'polygon' ? '⬡' : tool === 'ocr' ? 'T' : '◇'}<span>{TOOL_NAMES[tool]}</span></button>
          <div className="tool-divider" />
          <button className="tool-button" onClick={() => setResetToken((value) => value + 1)}><RotateCcw size={19} /><span>重設視角 R</span></button>
        </aside>
        <section className="canvas-column">
          <div className="mode-banner on">{tool === 'classification' ? '圖片分類模式 · 於右側選擇圖片層級 label · 右鍵拖曳視角' : '整合模式 · 左鍵標註／編輯 · 右鍵拖曳視角'}</div>
          {!currentImage ? (progressFilter === 'all' ? <div className="upload-empty"><ImagePlus size={46} /><strong>載入圖片／影片資料集</strong><span>可選擇多個檔案或整個資料夾；檔案會複製至專案資料夾</span><div className="upload-actions"><button className="primary-button" onClick={() => fileInputRef.current?.click()} disabled={uploading}><ImagePlus size={16} />選擇檔案</button><button className="secondary-button" onClick={() => folderInputRef.current?.click()} disabled={uploading}><FolderOpen size={16} />選擇資料夾</button></div></div> : <div className="upload-empty"><strong>此分群沒有檔案</strong><span>{progressFilter === 'completed' ? '目前沒有已完成的資料' : '目前沒有未完成的資料'}</span></div>) : <AnnotationCanvas image={currentImage} imageUrl={api.imageUrl(project.id, currentImage.id)} annotations={visibleAnnotations} labels={project.labels} activeLabelId={tool === 'ocr' ? 'ocr-text' : activeLabelId} tool={tool} selectedId={selectedId} onSelect={setSelectedId} onCommit={handleCanvasCommit} onUpdate={(id, points) => commit((current) => { const annotations = current.annotations.map((item) => item.id === id ? { ...item, points, ...(item.type === 'reid' && item.generated === true ? { keyframe: true, generated: false } : {}) } : item); return { ...current, annotations: tool === 'reid' ? regenerateReidAnnotations(annotations) : annotations } })} resetToken={resetToken} currentFrame={currentFrame} onFrameChange={(frame) => { setCurrentFrame(frame); setSelectedId(null) }} />}
          <footer className="image-nav"><button onClick={() => navigate(-1)} disabled={index === 0}><ChevronLeft size={18} />上一張</button><div className="progress-track"><span style={{ width: images.length ? `${((index + 1) / images.length) * 100}%` : '0%' }} /></div><button onClick={() => navigate(1)} disabled={index >= images.length - 1}>下一張<ChevronRight size={18} /></button><button className="secondary-button compact" onClick={() => fileInputRef.current?.click()} disabled={uploading}><ImagePlus size={16} />新增圖片</button><button className="secondary-button compact" onClick={() => folderInputRef.current?.click()} disabled={uploading}><FolderOpen size={16} />選擇資料夾</button></footer>
        </section>
        <aside className="inspector-panel">
          {tool !== 'ocr' && <section><span className="panel-label">目前 LABEL</span><div className="label-picker">{project.labels.filter((label) => !label.system).map((label) => <div className="label-picker-row" key={label.id}>{editingLabelId === label.id ? <><input autoFocus value={editingLabelName} onChange={(event) => setEditingLabelName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') renameLabel(); if (event.key === 'Escape') setEditingLabelId(null) }} /><button className="label-row-action confirm" title="儲存名稱" onClick={renameLabel} disabled={!editingLabelName.trim() || renamingLabel}><Check size={14} /></button><button className="label-row-action" title="取消" onClick={() => setEditingLabelId(null)}><X size={14} /></button></> : <><button className={`label-choice ${activeLabelId === label.id ? 'active' : ''}`} onClick={() => setActiveLabelId(label.id)}><i style={{ background: label.color }} />{label.name}</button><button className="label-row-action" title="修改名稱" onClick={() => { setEditingLabelId(label.id); setEditingLabelName(label.name) }}><Pencil size={14} /></button><button className="label-row-action danger" title="刪除未使用的 label" onClick={() => deleteLabel(label)} disabled={Boolean(deletingDefinition)}><Trash2 size={14} /></button></>}</div>)}</div><div className="label-add-row"><input value={newLabelName} onChange={(event) => setNewLabelName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addLabel() }} placeholder="輸入 label 名稱" /><button onClick={addLabel} disabled={!newLabelName.trim() || addingLabel}>{addingLabel ? '新增中…' : '新增'}</button></div></section>}
          {tool !== 'ocr' && tool !== 'classification' && activeLabel && <section><span className="panel-label">新增屬性 · {activeLabel.name}</span>{(activeLabel.attributes || []).length > 0 && <div className="attribute-summary">{activeLabel.attributes.map((attribute) => <span key={attribute.id}>{attribute.name}<small>{attribute.type === 'number' ? 'Number' : 'Text'}</small><button title="刪除未使用的屬性" onClick={() => deleteAttribute(attribute)} disabled={Boolean(deletingDefinition)}><X size={12} /></button></span>)}</div>}<div className="attribute-add-row"><input value={newAttributeName} onChange={(event) => setNewAttributeName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addAttribute() }} placeholder="屬性名稱" /><select value={newAttributeType} onChange={(event) => setNewAttributeType(event.target.value)}><option value="text">Text</option><option value="number">Number</option></select><button onClick={addAttribute} disabled={!newAttributeName.trim() || addingAttribute}>{addingAttribute ? '新增中…' : '新增'}</button></div></section>}
          {project.primaryMode === 'classification' && <section><span className="panel-label">圖片分類</span><div className="classification-list">{classificationLabels.map((label) => <label key={label.id}><input type={project.classificationMode === 'single' ? 'radio' : 'checkbox'} checked={document.classifications.some((item) => item.label_id === label.id)} onChange={() => toggleClassification(label.id)} /><i style={{ background: label.color }} />{label.name}</label>)}</div></section>}
          {project.primaryMode !== 'classification' && <section className="annotation-list-section"><span className="panel-label">目前畫面標註 · {visibleAnnotations.length}</span><div className="annotation-list">{visibleAnnotations.map((annotation, itemIndex) => {
            const label = project.labels.find((item) => item.id === annotation.labelId)
            return <button key={annotation.id} className={selectedId === annotation.id ? 'active' : ''} onClick={() => setSelectedId(annotation.id)}><i style={{ background: label?.color }} /><span>{label?.name || '未命名'}<small>{TOOL_NAMES[annotation.type]} #{itemIndex + 1}</small></span>{annotation.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
          })}</div></section>}
          {selected && <section className="selection-editor"><div className="selection-title"><span className="panel-label">選取項目</span><div><button className="icon-button" title={selected.hidden ? '顯示' : '隱藏'} onClick={() => updateSelected({ hidden: !selected.hidden })}>{selected.hidden ? <EyeOff size={15} /> : <Eye size={15} />}</button><button className="icon-button" title={selected.locked ? '解鎖' : '鎖定'} onClick={() => updateSelected({ locked: !selected.locked })}>{selected.locked ? <Lock size={15} /> : <Unlock size={15} />}</button><button className="icon-button danger" onClick={deleteSelected}><Trash2 size={15} /></button></div></div>
            {selected.type !== 'ocr' && <label className="field small"><span>Label</span><select value={selected.labelId} onChange={(e) => updateSelected({ labelId: e.target.value })}>{project.labels.filter((label) => !label.system).map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label>}
            {selected.type === 'reid' && <><label className="field small"><span>Identity ID（跨圖片身分）</span><input value={selected.identity_id || ''} onChange={(e) => updateSelected({ identity_id: e.target.value })} placeholder="例如 person_001" /></label><label className="field small"><span>Track ID（同影片軌跡）</span><input value={selected.track_id || ''} onChange={(e) => updateSelected({ track_id: e.target.value })} /></label><label className="field small"><span>Camera ID</span><input value={selected.camera_id || ''} onChange={(e) => updateSelected({ camera_id: e.target.value })} /></label>{currentImage?.mediaType === 'video' && <label className="classification-toggle"><input type="checkbox" checked={Boolean(selected.keyframe)} onChange={(e) => updateSelected({ keyframe: e.target.checked })} /><span><strong>關鍵影格</strong><small>此框為追蹤軌跡的明確標註點</small></span></label>}</>}
            {selectedLabel?.attributes.map((attribute) => <label className="field small" key={attribute.id}><span>{attribute.name}</span><input ref={selected.type === 'ocr' && attribute.id === 'transcription' ? ocrInputRef : null} type={attribute.type === 'number' ? 'number' : 'text'} value={selected.attributes?.[attribute.id] ?? ''} onChange={(e) => updateSelected({ attributes: { ...selected.attributes, [attribute.id]: attribute.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value } })} placeholder={selected.type === 'ocr' ? '輸入框內文字' : ''} /></label>)}
          </section>}
          <section className="shortcut-card"><span className="panel-label">快捷鍵</span><div><kbd>F</kbd>儲存、標記完成並前往下一張</div><div><kbd>A</kbd><kbd>D</kbd>切換圖片</div><div><kbd>R</kbd>重設視角</div><div><kbd>Del</kbd>刪除選取</div><div><kbd>Ctrl Z/Y</kbd>復原／重做</div><div><kbd>Alt 點擊</kbd>循環選取</div><div><kbd>Shift 點擊</kbd>在重疊處強制標註</div></section>
        </aside>
      </div>
    </main>
  )
}

import { useMemo, useState } from 'react'
import { ArrowLeft, Check, Plus, Trash2 } from 'lucide-react'
import { api } from '../api'
import { modeName } from '../App'

const MODE_OPTIONS = ['rectangle', 'polygon', 'ocr', 'rotated_rectangle', 'semantic_segmentation', 'instance_segmentation', 'reid', 'classification']
const COLORS = ['#fb7185', '#f59e0b', '#84cc16', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899']

const blankLabel = (index = 0) => ({
  id: crypto.randomUUID(), name: '', color: COLORS[index % COLORS.length], attributes: [],
})

const readableLabelId = (name, index) => name.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^[-_]+|[-_]+$/g, '') || `label-${index + 1}`

export default function ProjectSetup({ onCancel, onCreated }) {
  const [name, setName] = useState('')
  const [primaryMode, setPrimaryMode] = useState('rectangle')
  const [labels, setLabels] = useState([blankLabel()])
  const [classificationMode, setClassificationMode] = useState('multiple')
  const [mediaType, setMediaType] = useState('image')
  const [error, setError] = useState('')
  const labelsRequired = primaryMode !== 'ocr'
  const valid = useMemo(() => name.trim() && primaryMode && (!labelsRequired || labels.some((label) => label.name.trim())), [name, primaryMode, labelsRequired, labels])

  const updateLabel = (id, patch) => setLabels((all) => all.map((label) => label.id === id ? { ...label, ...patch } : label))
  const addAttribute = (labelId) => setLabels((all) => all.map((label) => label.id === labelId ? {
    ...label, attributes: [...label.attributes, { id: crypto.randomUUID(), name: '', type: 'text' }],
  } : label))

  const submit = async () => {
    setError('')
    try {
      let cleanLabels = labels.filter((label) => label.name.trim()).map((label) => ({
        ...label, name: label.name.trim(), attributes: label.attributes.filter((attribute) => attribute.name.trim()),
      }))
      cleanLabels = cleanLabels.map((label, index) => ({ ...label, id: readableLabelId(label.name, index) }))
      if (primaryMode === 'classification') cleanLabels = cleanLabels.map(({ id, name: labelName, color }) => ({ id, name: labelName, color }))
      if (primaryMode === 'ocr') cleanLabels = [{
        id: 'ocr-text', name: '文字', color: '#22d3ee', system: true,
        attributes: [{ id: 'transcription', name: '辨識文字', type: 'text', system: true }],
      }, ...cleanLabels]
      onCreated(await api.createProject({ name: name.trim(), primaryMode, labels: cleanLabels, ...(primaryMode === 'classification' ? { classificationMode } : {}), mediaType: primaryMode === 'reid' ? mediaType : 'image' }))
    } catch (err) { setError(err.message) }
  }

  return (
    <main className="setup-shell">
      <button className="text-button" onClick={onCancel}><ArrowLeft size={17} />返回專案列表</button>
      <div className="setup-heading"><span className="step-mark">01</span><div><h1>建立標註專案</h1><p>定義標註任務與可使用的 label。</p></div></div>
      {error && <div className="error-banner">{error}</div>}
      <section className="setup-section">
        <label className="field"><span>專案名稱</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：街景物件資料集" /></label>
        <div className="field"><span>主要標註方式（單選）</span><div className="option-grid primary-modes">{MODE_OPTIONS.map((mode) => {
          const selected = primaryMode === mode
          return <button key={mode} className={`option-card ${selected ? 'selected' : ''}`} onClick={() => setPrimaryMode(mode)}>{selected && <Check size={17} />}{modeName(mode)}</button>
        })}</div></div>
        {primaryMode === 'classification' && <label className="field"><span>圖片分類模式</span><select value={classificationMode} onChange={(e) => setClassificationMode(e.target.value)}><option value="single">單一分類</option><option value="multiple">多標籤分類</option></select></label>}
        {primaryMode === 'reid' && <label className="field"><span>ReID 資料來源</span><select value={mediaType} onChange={(e) => setMediaType(e.target.value)}><option value="image">圖片</option><option value="video">影片</option><option value="both">圖片與影片</option></select></label>}
      </section>
      {labelsRequired && <section className="setup-section">
        <div className="section-title"><div><span className="step-mark">02</span><h2>Labels</h2></div><button className="secondary-button" onClick={() => setLabels([...labels, blankLabel(labels.length)])}><Plus size={16} />新增 label</button></div>
        <div className="label-editor-list">{labels.map((label, index) => (
          <article className="label-editor" key={label.id}>
            <div className="label-row"><input type="color" value={label.color} onChange={(e) => updateLabel(label.id, { color: e.target.value })} /><input value={label.name} onChange={(e) => updateLabel(label.id, { name: e.target.value })} placeholder={`Label ${index + 1} 名稱`} /><button className="icon-button danger" onClick={() => setLabels(labels.filter((item) => item.id !== label.id))}><Trash2 size={16} /></button></div>
            {primaryMode !== 'classification' && label.attributes.map((attribute) => <div className="attribute-row" key={attribute.id}><span>屬性</span><input value={attribute.name} onChange={(e) => updateLabel(label.id, { attributes: label.attributes.map((item) => item.id === attribute.id ? { ...item, name: e.target.value } : item) })} placeholder="例如：文字內容" /><select value={attribute.type} onChange={(e) => updateLabel(label.id, { attributes: label.attributes.map((item) => item.id === attribute.id ? { ...item, type: e.target.value } : item) })}><option value="text">Text</option><option value="number">Number</option></select><button className="icon-button" onClick={() => updateLabel(label.id, { attributes: label.attributes.filter((item) => item.id !== attribute.id) })}>×</button></div>)}
            {primaryMode !== 'classification' && <button className="subtle-button" onClick={() => addAttribute(label.id)}><Plus size={14} />新增屬性</button>}
          </article>
        ))}</div>
      </section>}
      {primaryMode === 'ocr' && <section className="setup-section ocr-note"><span className="step-mark">02</span><div><h2>OCR 文字標註</h2><p>完成四點文字框後會立即要求輸入辨識文字，不需要預先建立 label。</p></div></section>}
      <footer className="setup-footer"><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary-button" disabled={!valid} onClick={submit}>建立並開啟專案</button></footer>
    </main>
  )
}

import { useEffect, useState } from 'react'
import { Boxes, Plus, Trash2 } from 'lucide-react'
import { api } from './api'
import ProjectSetup from './components/ProjectSetup'
import Workspace from './components/Workspace'

export default function App() {
  const [projects, setProjects] = useState([])
  const [active, setActive] = useState(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const refresh = async () => {
    try { setProjects(await api.listProjects()) } catch (err) { setError(err.message) }
  }
  useEffect(() => { refresh() }, [])

  if (active) return <Workspace project={active} onExit={() => { setCreating(false); setActive(null); refresh() }} />
  if (creating) return <ProjectSetup onCancel={() => setCreating(false)} onCreated={(project) => setActive(project)} />

  return (
    <main className="home-shell">
      <header className="home-header">
        <div><span className="eyebrow">LOCAL ANNOTATION WORKSPACE</span><h1>標註工作台</h1><p>管理資料集，建立精確且可追溯的標註。</p></div>
        <button className="primary-button" onClick={() => setCreating(true)}><Plus size={18} />建立專案</button>
      </header>
      {error && <div className="error-banner">{error}</div>}
      <section className="project-grid">
        {projects.length === 0 ? (
          <button className="empty-state" onClick={() => setCreating(true)}>
            <Boxes size={42} /><strong>尚無標註專案</strong><span>建立第一個專案並載入圖片資料集</span>
          </button>
        ) : projects.map((project) => (
          <article className="project-card" key={project.id} onClick={() => setActive(project)}>
            <div className="project-card-top"><span>{project.imageCount || 0} 張圖片</span><button className="icon-button danger" title="刪除專案" onClick={async (event) => {
              event.stopPropagation()
              if (confirm(`確定刪除「${project.name}」及所有標註資料？`)) { await api.deleteProject(project.id); refresh() }
            }}><Trash2 size={16} /></button></div>
            <h2>{project.name}</h2>
            <div className="mode-chips"><span>{modeName(project.primaryMode)}</span></div>
            <small>更新於 {new Date(project.updatedAt).toLocaleString('zh-TW')}</small>
          </article>
        ))}
      </section>
    </main>
  )
}

export const modeName = (mode) => ({
  rectangle: '矩形', polygon: '多邊形', ocr: 'OCR', rotated_rectangle: '旋轉矩形', classification: '圖片分類',
  semantic_segmentation: '語意分割', instance_segmentation: '實例分割', reid: 'ReID／追蹤',
}[mode] || mode)

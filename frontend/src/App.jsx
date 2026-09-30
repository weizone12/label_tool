import { useEffect, useState } from 'react'
import { ArrowLeft, Boxes, ChevronRight, Folder, LogOut, Plus, Trash2, Users } from 'lucide-react'
import { api } from './api'
import { authUrl, useAuth } from './AuthGate'
import AssignmentDialog from './components/AssignmentDialog'
import ProjectSetup from './components/ProjectSetup'
import Workspace from './components/Workspace'

const groupSegments = (group = '') => group.split('/').map((part) => part.trim()).filter(Boolean)
const groupPath = (segments) => segments.join(' / ')
const isSamePath = (left, right) => groupPath(groupSegments(left)) === groupPath(groupSegments(right))
const isWithinPath = (group, parent) => {
  const childSegments = groupSegments(group)
  const parentSegments = groupSegments(parent)
  return childSegments.length >= parentSegments.length && parentSegments.every((part, index) => childSegments[index] === part)
}

export default function App() {
  const user = useAuth()
  const [projects, setProjects] = useState([])
  const [active, setActive] = useState(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [assigning, setAssigning] = useState(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [activeGroup, setActiveGroup] = useState('')

  const refresh = async () => {
    try { setProjects(await api.listProjects()) } catch (err) { setError(err.message) }
  }
  useEffect(() => { refresh() }, [])

  const logout = async () => {
    setLoggingOut(true)
    setError('')
    try {
      await api.logout()
      window.location.reload()
    } catch (err) {
      setError(err.message)
      setLoggingOut(false)
    }
  }

  const groupNames = [...new Set(projects.flatMap((project) => {
    const segments = groupSegments(project.group)
    return segments.map((_, index) => groupPath(segments.slice(0, index + 1)))
  }))].sort((a, b) => a.localeCompare(b, 'zh-TW', { numeric: true, sensitivity: 'base' }))
  const activeSegments = groupSegments(activeGroup)
  const visibleProjects = activeGroup ? projects.filter((project) => isSamePath(project.group, activeGroup)) : projects.filter((project) => groupSegments(project.group).length === 0)
  const childGroups = [...new Set(projects.flatMap((project) => {
    const segments = groupSegments(project.group)
    if (segments.length <= activeSegments.length || !isWithinPath(project.group, activeGroup)) return []
    return [groupPath(segments.slice(0, activeSegments.length + 1))]
  }))].sort((a, b) => a.localeCompare(b, 'zh-TW', { numeric: true, sensitivity: 'base' }))

  const projectCard = (project) => (
    <article className="project-card" key={project.id} onClick={() => setActive(project)}>
      <div className="project-card-top"><span>{project.imageCount || 0} 張圖片</span>{user.is_admin && <><button className="icon-button" title="指派執行人員" onClick={(event) => { event.stopPropagation(); setAssigning(project) }}><Users size={16} /></button><button className="icon-button danger" title="刪除專案" onClick={async (event) => {
        event.stopPropagation()
        if (confirm(`確定刪除「${project.name}」及所有標註資料？`)) { await api.deleteProject(project.id); refresh() }
      }}><Trash2 size={16} /></button></>}</div>
      <h2>{project.name}</h2>
      <div className="mode-chips"><span>{project.projectType === 'editing' ? '純修改專案' : '標註專案'}</span><span>{modeName(project.primaryMode)}</span></div>
      <small>更新於 {new Date(project.updatedAt).toLocaleString('zh-TW')}</small>
    </article>
  )

  if (active) return <Workspace project={active} isAdmin={user.is_admin} onExit={() => { setCreating(false); setActive(null); refresh() }} />
  if (creating) return <ProjectSetup existingGroups={groupNames} initialGroup={activeGroup} onCancel={() => setCreating(false)} onCreated={(project) => setActive(project)} />

  return (
    <main className="home-shell">
      <button className="secondary-button home-logout" onClick={logout} disabled={loggingOut}>
        <LogOut size={16} />{loggingOut ? '登出中…' : '登出'}
      </button>
      <header className="home-header">
        <div><span className="eyebrow">LOCAL ANNOTATION WORKSPACE</span><h1>MIKO 標註達人</h1><p>管理資料集，建立精確且可追溯的標註。</p></div>
        {user.is_admin && <div className="home-actions">
          <button className="secondary-button" onClick={() => window.location.assign(authUrl('/admin/users'))}><Users size={18} />管理使用者</button>
          <button className="primary-button" onClick={() => setCreating(true)}><Plus size={18} />建立專案</button>
        </div>}
      </header>
      {error && <div className="error-banner">{error}</div>}
      {activeGroup && <div className="group-toolbar"><button className="text-button" onClick={() => setActiveGroup(groupPath(activeSegments.slice(0, -1)))}><ArrowLeft size={17} />返回上一層</button><div className="group-breadcrumbs"><button onClick={() => setActiveGroup('')}>所有專案</button>{activeSegments.map((part, index) => <span key={groupPath(activeSegments.slice(0, index + 1))}><ChevronRight size={14} /><button onClick={() => setActiveGroup(groupPath(activeSegments.slice(0, index + 1)))}>{part}</button></span>)}<em>{visibleProjects.length} 個專案</em></div></div>}
      <section className="project-grid">
        {projects.length === 0 ? (
          user.is_admin ? <button className="empty-state" onClick={() => setCreating(true)}>
            <Boxes size={42} /><strong>尚無標註專案</strong><span>建立第一個專案並載入圖片資料集</span>
          </button> : <div className="empty-state"><Boxes size={42} /><strong>目前沒有被指派的專案</strong><span>請聯絡管理員指派專案</span></div>
        ) : <>
          {childGroups.map((groupName) => {
            const grouped = projects.filter((project) => isWithinPath(project.group, groupName))
            const imageCount = grouped.reduce((total, project) => total + (project.imageCount || 0), 0)
            return <article className="project-card group-card" key={groupName} onClick={() => setActiveGroup(groupName)}>
              <div className="project-card-top"><span>{grouped.length} 個專案 · {imageCount} 張圖片</span><Folder size={18} /></div>
              <h2>{groupSegments(groupName).at(-1)}</h2>
              <div className="group-card-open">開啟群組<ChevronRight size={17} /></div>
              <small>更新於 {new Date(Math.max(...grouped.map((project) => new Date(project.updatedAt).getTime()))).toLocaleString('zh-TW')}</small>
            </article>
          })}
          {visibleProjects.map(projectCard)}
          {activeGroup && visibleProjects.length === 0 && childGroups.length === 0 && <div className="empty-state"><Folder size={42} /><strong>群組內沒有專案</strong></div>}
        </>}
      </section>
      {assigning && <AssignmentDialog project={assigning} onClose={() => setAssigning(null)} />}
    </main>
  )
}

export const modeName = (mode) => ({
  rectangle: '矩形', polygon: '多邊形', ocr: 'OCR', rotated_rectangle: '旋轉矩形', classification: '圖片分類',
  semantic_segmentation: '語意分割', instance_segmentation: '實例分割', reid: 'ReID／追蹤',
}[mode] || mode)

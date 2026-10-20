import { useEffect, useState } from 'react'
import { ArrowLeft, Boxes, CheckCircle2, ChevronRight, Folder, LogOut, Plus, RefreshCw, Trash2, Users } from 'lucide-react'
import { api } from './api'
import { authUrl, useAuth } from './AuthGate'
import AssignmentDialog from './components/AssignmentDialog'
import ProjectSetup from './components/ProjectSetup'
import Workspace from './components/Workspace'

const groupSegments = (group = '') => group.split('/').map((part) => part.trim()).filter(Boolean)
const groupPath = (segments) => segments.join(' / ')
const isSamePath = (left, right) => groupPath(groupSegments(left)) === groupPath(groupSegments(right))
const compareNames = (left, right) => String(left || '').localeCompare(String(right || ''), 'zh-TW', { numeric: true, sensitivity: 'base' })
const compareGroupDisplayNames = (left, right) => {
  const leftName = groupSegments(left).at(-1) || ''
  const rightName = groupSegments(right).at(-1) || ''
  return compareNames(leftName, rightName) || compareNames(left, right)
}
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
  const [assigningGroup, setAssigningGroup] = useState(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const [notice, setNotice] = useState('')
  const [activeGroup, setActiveGroup] = useState('')
  const [managedUsers, setManagedUsers] = useState([])
  const [assignedUserFilter, setAssignedUserFilter] = useState('')

  const refresh = async () => {
    try {
      const [nextProjects, nextUsers] = await Promise.all([
        api.listProjects(),
        user.is_admin ? api.listManagedUsers() : Promise.resolve([]),
      ])
      setProjects(nextProjects)
      setManagedUsers(nextUsers)
    } catch (err) { setError(err.message) }
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

  const reconcileProjects = async () => {
    setReconciling(true)
    setError('')
    setNotice('')
    try {
      const result = await api.reconcileProjects()
      await refresh()
      setNotice(`已重新檢查 ${result.projectsChecked} 個專案，移除 ${result.removedEntries} 筆失效索引，補回 ${result.addedEntries} 筆圖片索引。`)
    } catch (err) {
      setError(err.message)
    } finally {
      setReconciling(false)
    }
  }

  const groupNames = [...new Set(projects.flatMap((project) => {
    const segments = groupSegments(project.group)
    return segments.map((_, index) => groupPath(segments.slice(0, index + 1)))
  }))].sort((a, b) => a.localeCompare(b, 'zh-TW', { numeric: true, sensitivity: 'base' }))
  const projectUsers = managedUsers.filter((item) => !item.is_admin).sort((a, b) => compareNames(a.display_name || a.username, b.display_name || b.username))
  const usersById = new Map(projectUsers.map((item) => [item.id, item]))
  const filteredByUser = assignedUserFilter === '__unassigned__'
    ? projects.filter((project) => !(project.assignedUserIds || []).length)
    : assignedUserFilter
      ? projects.filter((project) => (project.assignedUserIds || []).includes(assignedUserFilter))
      : projects
  const activeSegments = groupSegments(activeGroup)
  const visibleProjects = activeGroup
    ? filteredByUser.filter((project) => isSamePath(project.group, activeGroup)).sort((a, b) => compareNames(a.name, b.name))
    : filteredByUser.filter((project) => groupSegments(project.group).length === 0)
  const childGroups = [...new Set(filteredByUser.flatMap((project) => {
    const segments = groupSegments(project.group)
    if (segments.length <= activeSegments.length || !isWithinPath(project.group, activeGroup)) return []
    return [groupPath(segments.slice(0, activeSegments.length + 1))]
  }))].sort(compareGroupDisplayNames)

  const projectCard = (project) => (
    <article className="project-card" key={project.id} onClick={() => setActive(project)}>
      <div className="project-card-top"><span>{project.imageCount || 0} 張圖片</span><div className="project-card-actions">{project.completed && <span className="project-complete-badge"><CheckCircle2 size={14} />已完成</span>}{user.is_admin && <><button className="icon-button" title="指派執行人員" onClick={(event) => { event.stopPropagation(); setAssigning(project) }}><Users size={16} /></button><button className="icon-button danger" title="刪除專案" onClick={async (event) => {
        event.stopPropagation()
        if (confirm(`確定刪除「${project.name}」及所有標註資料？`)) { await api.deleteProject(project.id); refresh() }
      }}><Trash2 size={16} /></button></>}</div></div>
      <h2>{project.name}</h2>
      <div className="mode-chips"><span>{project.projectType === 'editing' ? '純修改專案' : '標註專案'}</span><span>{modeName(project.primaryMode)}</span></div>
      {user.is_admin && <div className="project-assignees"><Users size={14} /><div>{(project.assignedUserIds || []).length ? project.assignedUserIds.map((userId) => {
        const assignedUser = usersById.get(userId)
        return <span className="project-assignee" key={userId} title={assignedUser?.username || userId}>{assignedUser?.display_name || assignedUser?.username || '未知使用者'}</span>
      }) : <span className="project-unassigned">未指派</span>}</div></div>}
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
          <button className="secondary-button" onClick={reconcileProjects} disabled={reconciling}><RefreshCw size={18} className={reconciling ? 'spin' : ''} />{reconciling ? '重新檢查中…' : '重新檢查專案'}</button>
          <button className="secondary-button" onClick={() => window.location.assign(authUrl('/admin/users'))}><Users size={18} />管理使用者</button>
          <button className="primary-button" onClick={() => setCreating(true)}><Plus size={18} />建立專案</button>
        </div>}
      </header>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}
      {user.is_admin && projects.length > 0 && <div className="project-filter-bar"><Users size={17} /><label><span>依指派使用者篩選</span><select value={assignedUserFilter} onChange={(event) => { setAssignedUserFilter(event.target.value); setActiveGroup('') }}><option value="">全部專案</option><option value="__unassigned__">未指派</option>{projectUsers.map((item) => <option key={item.id} value={item.id}>{item.display_name || item.username}{item.status !== 'active' ? '（已停用）' : ''}</option>)}</select></label><em>{filteredByUser.length} 個專案</em></div>}
      {activeGroup && <div className="group-toolbar"><button className="text-button" onClick={() => setActiveGroup(groupPath(activeSegments.slice(0, -1)))}><ArrowLeft size={17} />返回上一層</button><div className="group-breadcrumbs"><button onClick={() => setActiveGroup('')}>所有專案</button>{activeSegments.map((part, index) => <span key={groupPath(activeSegments.slice(0, index + 1))}><ChevronRight size={14} /><button onClick={() => setActiveGroup(groupPath(activeSegments.slice(0, index + 1)))}>{part}</button></span>)}<em>{visibleProjects.length} 個專案</em></div></div>}
      <section className="project-grid">
        {projects.length === 0 ? (
          user.is_admin ? <button className="empty-state" onClick={() => setCreating(true)}>
            <Boxes size={42} /><strong>尚無標註專案</strong><span>建立第一個專案並載入圖片資料集</span>
          </button> : <div className="empty-state"><Boxes size={42} /><strong>目前沒有被指派的專案</strong><span>請聯絡管理員指派專案</span></div>
        ) : filteredByUser.length === 0 ? <div className="empty-state"><Users size={42} /><strong>沒有符合此篩選的專案</strong><span>請選擇其他使用者或查看全部專案</span></div> : <>
          {childGroups.map((groupName) => {
            const grouped = filteredByUser.filter((project) => isWithinPath(project.group, groupName))
            const allGrouped = projects.filter((project) => isWithinPath(project.group, groupName))
            const groupDepth = groupSegments(groupName).length
            const isLeafGroup = allGrouped.length > 0 && allGrouped.every((project) => groupSegments(project.group).length === groupDepth)
            const imageCount = grouped.reduce((total, project) => total + (project.imageCount || 0), 0)
            const completed = grouped.length > 0 && grouped.every((project) => project.completed)
            return <article className="project-card group-card" key={groupName} onClick={() => setActiveGroup(groupName)}>
              <div className="project-card-top"><span>{grouped.length} 個專案 · {imageCount} 張圖片</span><div className="project-card-actions">{completed && <span className="project-complete-badge"><CheckCircle2 size={14} />已完成</span>}{user.is_admin && isLeafGroup && <button className="icon-button" title="指派群組內全部專案" onClick={(event) => { event.stopPropagation(); setAssigningGroup({ name: groupName, projects: allGrouped }) }}><Users size={16} /></button>}<Folder size={18} /></div></div>
              <h2>{groupSegments(groupName).at(-1)}</h2>
              <div className="group-card-open">開啟群組<ChevronRight size={17} /></div>
              <small>更新於 {new Date(Math.max(...grouped.map((project) => new Date(project.updatedAt).getTime()))).toLocaleString('zh-TW')}</small>
            </article>
          })}
          {visibleProjects.map(projectCard)}
          {activeGroup && visibleProjects.length === 0 && childGroups.length === 0 && <div className="empty-state"><Folder size={42} /><strong>群組內沒有專案</strong></div>}
        </>}
      </section>
      {assigning && <AssignmentDialog project={assigning} onClose={() => setAssigning(null)} onSaved={(userIds) => setProjects((items) => items.map((project) => project.id === assigning.id ? { ...project, assignedUserIds: userIds } : project))} />}
      {assigningGroup && <AssignmentDialog group={assigningGroup} onClose={() => setAssigningGroup(null)} onSaved={(userIds) => { const projectIds = new Set(assigningGroup.projects.map((project) => project.id)); setProjects((items) => items.map((project) => projectIds.has(project.id) ? { ...project, assignedUserIds: userIds } : project)) }} />}
    </main>
  )
}

export const modeName = (mode) => ({
  rectangle: '矩形', polygon: '多邊形', ocr: 'OCR', rotated_rectangle: '旋轉矩形', classification: '圖片分類',
  semantic_segmentation: '語意分割', instance_segmentation: '實例分割', reid: 'ReID／追蹤',
}[mode] || mode)

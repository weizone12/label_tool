import { useEffect, useState } from 'react'
import { api } from '../api'

export default function AssignmentDialog({ project, group, onClose, onSaved }) {
  const [users, setUsers] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [mixedAssignments, setMixedAssignments] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const assignmentRequest = group
      ? Promise.resolve((() => {
          const assignments = group.projects.map((item) => item.assignedUserIds || [])
          const signatures = new Set(assignments.map((userIds) => [...userIds].sort().join('\u0000')))
          setMixedAssignments(signatures.size > 1)
          return assignments.length
            ? assignments[0].filter((userId) => assignments.every((userIds) => userIds.includes(userId)))
            : []
        })())
      : api.getAssignments(project.id)
    Promise.all([api.listManagedUsers(), assignmentRequest])
      .then(([allUsers, userIds]) => {
        setUsers(allUsers.filter((user) => !user.is_admin && user.status === 'active'))
        setSelected(new Set(userIds))
      })
      .catch((err) => setError(err.message))
  }, [group, project])

  const toggle = (userId) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(userId)) next.delete(userId); else next.add(userId)
    return next
  })

  const save = async () => {
    setSaving(true); setError('')
    try {
      const userIds = group
        ? (await api.updateGroupAssignments(group.projects.map((item) => item.id), [...selected])).user_ids
        : await api.updateAssignments(project.id, [...selected])
      onSaved?.(userIds)
      onClose()
    }
    catch (err) { setError(err.message); setSaving(false) }
  }

  return <div className="assignment-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="assignment-dialog" role="dialog" aria-modal="true" aria-labelledby="assignment-title">
      <h2 id="assignment-title">{group ? '指派群組執行人員' : '指派專案執行人員'}</h2>
      <p>{group ? `${group.name} · ${group.projects.length} 個專案` : project.name}</p>
      {group && <div className={`assignment-note ${mixedAssignments ? 'warning' : ''}`}>{mixedAssignments ? '群組內目前的指派不一致；儲存後會將勾選結果統一套用到全部專案。' : '儲存後會將勾選結果套用到群組內全部專案。'}</div>}
      <div className="assignment-users">{users.length === 0 ? <span>目前沒有可指派的一般使用者</span> : users.map((user) =>
        <label key={user.id}><input type="checkbox" checked={selected.has(user.id)} onChange={() => toggle(user.id)} />
          <span><strong>{user.display_name || user.username}</strong><small>{user.username}</small></span>
        </label>
      )}</div>
      {error && <div className="error-banner">{error}</div>}
      <footer><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving} onClick={save}>{saving ? '儲存中…' : '儲存指派'}</button></footer>
    </section>
  </div>
}

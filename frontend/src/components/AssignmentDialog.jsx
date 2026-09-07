import { useEffect, useState } from 'react'
import { api } from '../api'

export default function AssignmentDialog({ project, onClose }) {
  const [users, setUsers] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    Promise.all([api.listManagedUsers(), api.getAssignments(project.id)])
      .then(([allUsers, userIds]) => {
        setUsers(allUsers.filter((user) => !user.is_admin && user.status === 'active'))
        setSelected(new Set(userIds))
      })
      .catch((err) => setError(err.message))
  }, [project.id])

  const toggle = (userId) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(userId)) next.delete(userId); else next.add(userId)
    return next
  })

  const save = async () => {
    setSaving(true); setError('')
    try { await api.updateAssignments(project.id, [...selected]); onClose() }
    catch (err) { setError(err.message); setSaving(false) }
  }

  return <div className="assignment-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="assignment-dialog" role="dialog" aria-modal="true" aria-labelledby="assignment-title">
      <h2 id="assignment-title">指派專案執行人員</h2>
      <p>{project.name}</p>
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

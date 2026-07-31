    async function callAgendaTasksApi(action, payload = {}) {
        const res = await fetch('/api/agenda-tasks-v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json'},
            body: JSON.stringify({action, ...payload}),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'agenda task request failed')
        return data
    }
    
    export async function createTask(title, description, deadline = null, startDate = null, status, priority, assignerId = null, executors){
        const { task } = await callAgendaTasksApi('create', {title, description, deadline, startDate, status, priority, assignerId, executors})
        return task
    }

    export async function updateTask({ taskId, title, description, deadline = null, startDate = null, status, priority, assignerId = null, executors}){
        const { task } = await callAgendaTasksApi('update', {taskId, title, description, deadline, startDate, status, priority, assignerId, executors})
        return task
    }

    export async function setTaskStatus({ taskId, status }){
        const { task } = await callAgendaTasksApi('setStatus', {taskId, status})
        return task
    }

    export async function duplicateTask({ taskId }){
        const { task } = await callAgendaTasksApi('duplicate', {taskId})
        return task
    }

    export async function deleteTask({ taskId }){
        const { deletedTaskId } = await callAgendaTasksApi('delete', {taskId})
        return deletedTaskId
    }

    export async function addTaskLink({ taskId, entityType, entityId }){
        const { task } = await callAgendaTasksApi('addLink', {taskId, entityType, entityId})
        return task
    }

    export async function removeTaskLink({ linkId }){
        const { deletedLinkId } = await callAgendaTasksApi('removeLink', {linkId})
        return deletedLinkId
    }


// handleDuplicateTask(): swap to the new duplicateTask(...)
// handleReopenTask():   swap to the new setTaskStatus({ taskId, status: 'not_started' })

// renderTaskLinksSection()'s remove-link button handler: swap to removeTaskLink(...)
// handleAddLink():      swap to addTaskLink(...)
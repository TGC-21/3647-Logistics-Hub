The purpose of this document is to provide details and information for a new "Agenda" workflow.

## Purpose
The Agenda is the operational planning system for Partshelf. It converts engineering work into trackable tasks and serves as the central coordination point between Inventory, Designer, Fabricate, and Part Orders. It exists specifically to support the manufacturing workflow at a very basic and intuitive level.

## Goals 
To orchestrate tasks to facilitate the collection of parts, machining of parts, and final assembly. Users should immediately know what's going on and what there is to do at a glance. The Agenda serves as an entry point to the rest of the app: User is out of the loop --> user opens web app and sees the agenda immediately --> User needs to fabricate part, can check "designer" tab and "fabricate" tab for more info

## Non Goals
Team chat
complicated charts
full-scale team and project management
a complete calendar system

## Philosophy
The agenda system should integrate with the rest of the app whenever possible. The agenda should also reuse and conform to existing patterns within the app whenever possible. 

Avoid introducing duplicate state management.

Favor composable database models.

Tasks should act as references between existing systems rather than duplicating information.

## Implementation
The Agenda will live as a tab alongside "Inventory," "Designer," "Fabricate," and "Part Orders. It will contain a calendar view (not by default) and frame tasks within a timeline/time frame.

The default view is a full-page view of the current day. Day information can live at the top of the screen (Monday, September 1). Most of the screen will be taken up by "Tasks." The user can expand the view to the current week, and then the current month.

## Tasks
"Tasks" are an organization unit. Like inventory instances in the "Inventory" tab or assembly parts/part rows in the "designer" tab, these are the most basic building blocks of the Agenda workflow. Like assemblies, tasks could also display revision history per the git-style commit history, but this could be implemented later. 

### Task Schema: Take this as a suggestion for what a task should contain, but do not hesitate to suggest your own ideas and changes
> id - unique id for each task
> title - task name, ie. "Machine gearbox shafts"
> description - user-dictated relevant information 
> deadline - date the task needs to be completed by
> status - not started/started/complete, etc
> priority - low, medium, high priority
> assigner - who created this task
> assignees[] - optional field that the assigner can populate. 
> executors[] - the user(s) who actually *commit* to the task. The difference between assignees[] and executors[] is that assignees[] describes the people the assigner specifically wants for the task. executors[] describes the people who are actually available/interested and willingly take the task
> relatedItem - The fabrication job, inventory item, part order that the task necessitates or is heavily tied to. Alternatively, split into three fields (relatedFabricationJob, relatedInventoryItem, relatedPartOrder) if a single relatedItem field cannot cover all three types of object.
> startDate - when should the team start attempting this task? By default, tasks start immediately
> createdAt - when was this task created?
> completedAt - when was this task completed?
 
### Task Behavior
tasks can:
- be created manually
- be edited
- be deleted
- be duplicated
- be completed
- be assigned
- have attachments
- link to fabrication jobs, inventory instances, and part orders


### Task Lifecycle
Draft --> Task displayed in the Agenda tab --> Users (executors) claim and agree to accomplish task --> task gets marked "in progress" and "done" as executors make progress --> task archived

It's worth mentioning that completed tasks and archived tasks should be able to be reopened in case the task wasn't actually completed, or users failed to do the task correctly and must reattempt it. However, this functionality is not a must-have and if it is too difficult to implement or logically flawed per your judgement, it is okay to discard this function.

### deadlines
Deadlines should be universal (date + time, timezone accounted for)
If a task's deadline passes, continue displaying the task everyday, with an explicit "edit" and "discard" button.

## UI
├── Day View (default)
├── Week View
└── Month View

Like a calendar, the UI should be able to transition between these three views. 
### Day View
Includes all tasks that are ongoing, sorted by deadline and priority. The first few tasks should have maximum clarity (user can see every single field). If there are too many tasks, the rest collapse into small blocks. All tasks should be able to expand and bring up a menu/modal when clicked on. Tasks can be organized into a grid on desktop, and be listed like rows in a table on mobile (doesn't mean it has to BE a row in a table, I'm just describing the appearance)

### Week View
Each day is visible, and individual tasks become even smaller that only display once they are clicked. Because tasks have a startDate and a deadline, tasks that span multiple days can be visualized.

### Month View
Similar to week view, and should show tasks that span multiple days.

## Integrations and Relationships
Task
│
├── may reference Inventory Items
├── may reference Fabrication Jobs
├── may reference CAD Files
├── may reference Purchase Orders
└── may reference Parts

as a starting point, fabrication jobs can be attached to a task, and in the task view there could be a direct link to the fabrication job for convenience.

## implementation acceptance
The implementation is complete when:

✓ User can create a task
✓ User can edit a task
✓ User can delete a task
✓ User can assign members
✓ User can attach fabrication jobs, inventory instances, or part orders
✓ Day/Week/Month views function
✓ Database persists tasks
✓ Routing is integrated
✓ Existing tabs remain functional

## Future Plans (out of scope for the present)
Tasks are automatically created from reading user messages from Discord. The agentic harness will interpret user messages ("Tomorrow I think we should machine the gearbox shaft") and turn them into tasks (Search fabrication jobs for "Gearbox Shaft" --> create task "fabricate GB shaft")

Discord Message
↓
Agent Harness
↓
Intent Extraction
↓
Relevant Objects Search
↓
Task Proposal
↓
User Confirmation (optional)
↓
Task Creation

Read AGENTIC_HARNESS.md for information on the agentic harness.
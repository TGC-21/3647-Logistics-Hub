// src/loginScreen.js
//
// Controls the #login-overlay markup (see login_screen.html) — two
// panes (sign in / create member) toggled in place. Exposes a single
// requireLogin() entry point that resolves once someone is signed in,
// so main.js's boot() can simply `await requireLogin()` before doing
// anything else.
//
// Deliberately NOT dismissible (no close button, no backdrop-click-to-
// close) — signing in is a precondition for using the app, not an
// optional modal.

import { loginMember, addMember, getCurrentMemberId } from './members.js'

let resolveLogin = null

function showPane(pane) {
  document.getElementById('login-pane').style.display  = pane === 'login'  ? 'flex' : 'none'
  document.getElementById('create-pane').style.display  = pane === 'create' ? 'flex' : 'none'
  document.getElementById('login-modal-title').textContent = pane === 'create' ? 'Create a member' : 'Sign in'
  clearErrors()
}

function clearErrors() {
  const loginErr  = document.getElementById('login-error')
  const createErr = document.getElementById('create-error')
  loginErr.style.display = 'none'
  createErr.style.display = 'none'
}

function showError(pane, message) {
  const el = document.getElementById(pane === 'create' ? 'create-error' : 'login-error')
  el.textContent = message
  el.style.display = 'block'
}

async function handleLoginSubmit() {
  const idInput = document.getElementById('login-field-id')
  const btn = document.getElementById('btn-login-submit')
  const id = idInput.value.trim()

  btn.disabled = true
  try {
    await loginMember(id)
    closeLoginOverlay()
  } catch (e) {
    showError('login', e.message || 'Could not sign in')
    idInput.focus()
  } finally {
    btn.disabled = false
  }
}

async function handleCreateSubmit() {
  const nameInput = document.getElementById('create-field-name')
  const idInput   = document.getElementById('create-field-id')
  const btn = document.getElementById('btn-create-submit')

  btn.disabled = true
  try {
    await addMember(idInput.value.trim(), nameInput.value.trim())
    await loginMember(idInput.value.trim())
    closeLoginOverlay()
  } catch (e) {
    showError('create', e.message || 'Could not create member')
  } finally {
    btn.disabled = false
  }
}

function closeLoginOverlay() {
  document.getElementById('login-overlay').style.display = 'none'
  if (resolveLogin) { resolveLogin(getCurrentMemberId()); resolveLogin = null }
}

/** Binds the overlay's static event listeners — call once at app
 *  startup, same convention as every other bind*Events() in the
 *  codebase (bindDesignerEvents, bindFabricateEvents, etc). */
export function bindLoginScreenEvents() {
  document.getElementById('btn-login-submit').addEventListener('click', handleLoginSubmit)
  document.getElementById('btn-create-submit').addEventListener('click', handleCreateSubmit)
  document.getElementById('btn-show-create-member').addEventListener('click', () => showPane('create'))
  document.getElementById('btn-show-login').addEventListener('click', () => showPane('login'))

  document.getElementById('login-field-id').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLoginSubmit()
  })
  document.getElementById('create-field-id').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleCreateSubmit()
  })
}

/**
 * Shows the overlay if nobody is signed in and returns a Promise that
 * resolves with the memberId once sign-in/create succeeds. Resolves
 * immediately (no overlay shown) if a session was already restored.
 */
export function requireLogin() {
  if (getCurrentMemberId()) return Promise.resolve(getCurrentMemberId())

  showPane('login')
  document.getElementById('login-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('login-field-id').focus(), 80)

  return new Promise(resolve => { resolveLogin = resolve })
}
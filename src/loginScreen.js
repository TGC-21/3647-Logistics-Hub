// src/loginScreen.js
//
// Three panes now instead of two: sign in (ID + password), create
// member (ID + name + password), and set-password (for a pre-migration
// member whose auth_user_id is still null — loginMember() throws
// 'NEEDS_PASSWORD_SETUP' to route here). Same non-dismissible contract
// as before: no close button, resolves requireLogin()'s promise once
// any pane succeeds.

import { loginMember, addMember, setInitialPassword, getCurrentMemberId } from './members.js'

let resolveLogin = null
let pendingSetupId = null   // ID awaiting password setup, set when loginMember() signals NEEDS_PASSWORD_SETUP

function showPane(pane) {
  document.getElementById('login-pane').style.display  = pane === 'login'  ? 'flex' : 'none'
  document.getElementById('create-pane').style.display  = pane === 'create' ? 'flex' : 'none'
  document.getElementById('setup-pane').style.display   = pane === 'setup'  ? 'flex' : 'none'
  document.getElementById('login-modal-title').textContent =
    pane === 'create' ? 'Create a member' : pane === 'setup' ? 'Set your password' : 'Sign in'
  clearErrors()
}

function clearErrors() {
  ['login-error', 'create-error', 'setup-error'].forEach(id => {
    const el = document.getElementById(id)
    el.style.display = 'none'
  })
}

function showError(pane, message) {
  const el = document.getElementById(pane === 'create' ? 'create-error' : pane === 'setup' ? 'setup-error' : 'login-error')
  el.textContent = message
  el.style.display = 'block'
}

async function handleLoginSubmit() {
  const idInput  = document.getElementById('login-field-id')
  const pwInput  = document.getElementById('login-field-password')
  const btn = document.getElementById('btn-login-submit')
  const id = idInput.value.trim()
  const password = pwInput.value

  btn.disabled = true
  try {
    await loginMember(id, password)
    closeLoginOverlay()
  } catch (e) {
    if (e.message === 'NEEDS_PASSWORD_SETUP') {
      pendingSetupId = id
      document.getElementById('setup-field-id').value = id
      showPane('setup')
    } else {
      showError('login', e.message || 'Could not sign in')
      pwInput.focus()
    }
  } finally {
    btn.disabled = false
  }
}

async function handleCreateSubmit() {
  const nameInput = document.getElementById('create-field-name')
  const idInput   = document.getElementById('create-field-id')
  const pwInput   = document.getElementById('create-field-password')
  const btn = document.getElementById('btn-create-submit')

  btn.disabled = true
  try {
    await addMember(idInput.value.trim(), nameInput.value.trim(), pwInput.value)
    await loginMember(idInput.value.trim(), pwInput.value)
    closeLoginOverlay()
  } catch (e) {
    showError('create', e.message || 'Could not create member')
  } finally {
    btn.disabled = false
  }
}

async function handleSetupSubmit() {
  const pwInput  = document.getElementById('setup-field-password')
  const pwInput2 = document.getElementById('setup-field-password-confirm')
  const btn = document.getElementById('btn-setup-submit')

  if (pwInput.value !== pwInput2.value) {
    showError('setup', 'Passwords do not match')
    return
  }

  btn.disabled = true
  try {
    await setInitialPassword(pendingSetupId, pwInput.value)
    closeLoginOverlay()
  } catch (e) {
    showError('setup', e.message || 'Could not set password')
  } finally {
    btn.disabled = false
  }
}

function closeLoginOverlay() {
  document.getElementById('login-overlay').style.display = 'none'
  pendingSetupId = null
  if (resolveLogin) { resolveLogin(getCurrentMemberId()); resolveLogin = null }
}

export function bindLoginScreenEvents() {
  document.getElementById('btn-login-submit').addEventListener('click', handleLoginSubmit)
  document.getElementById('btn-create-submit').addEventListener('click', handleCreateSubmit)
  document.getElementById('btn-setup-submit').addEventListener('click', handleSetupSubmit)
  document.getElementById('btn-show-create-member').addEventListener('click', () => showPane('create'))
  document.getElementById('btn-show-login').addEventListener('click', () => showPane('login'))
  document.getElementById('btn-setup-back-to-login').addEventListener('click', () => { pendingSetupId = null; showPane('login') })

  document.getElementById('login-field-password').addEventListener('keydown', e => { if (e.key === 'Enter') handleLoginSubmit() })
  document.getElementById('create-field-password').addEventListener('keydown', e => { if (e.key === 'Enter') handleCreateSubmit() })
  document.getElementById('setup-field-password-confirm').addEventListener('keydown', e => { if (e.key === 'Enter') handleSetupSubmit() })
}

export function requireLogin() {
  if (getCurrentMemberId()) return Promise.resolve(getCurrentMemberId())

  showPane('login')
  document.getElementById('login-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('login-field-id').focus(), 80)

  return new Promise(resolve => { resolveLogin = resolve })
}
type StateErrorCode = 'state_read_failed' | 'state_write_failed' | 'state_invalid'
  | 'state_directory_unavailable' | 'lock_unavailable'

export class StateError extends Error {
  constructor(readonly code: StateErrorCode) {
    super(code)
    this.name = 'StateError'
  }
}

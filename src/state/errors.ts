type StateErrorCode = 'state_read_failed' | 'state_write_failed' | 'state_invalid'
  | 'state_version_unsupported' | 'identity_mismatch' | 'binding_mismatch' | 'lock_unavailable' | 'recovery_no_checkpoint'

export class StateError extends Error {
  constructor(readonly code: StateErrorCode) {
    super(code)
    this.name = 'StateError'
  }
}

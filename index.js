/**
 * Host half of dsh-notify.
 *
 * The plugin is a pure web-client feature: it reads the client-side
 * `uiSession.sessionStatus` store and renders browser notifications and
 * in-page cards. It therefore needs no host service, no commands, and no
 * config. This empty `apply` exists only so the bundle row in
 * `cordis.patch.yml` resolves to a valid host plugin; the browser half is
 * `client.js`.
 */
export function apply() {}

// Public Android packages never seed or replace third-party extensions.
// Keep this compatibility entry point for callers; existing user directories,
// manifests and uninstall history belong to the user and remain untouched.
export async function seedExtensions() {}

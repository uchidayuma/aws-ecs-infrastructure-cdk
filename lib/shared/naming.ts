export function rdsDbName(project: string, environment: string): string {
  // Prefer underscores for readability and MySQL compatibility (hyphens are not allowed).
  const base = `${project}_db_${environment}`.toLowerCase();
  // Allow only letters, numbers, and underscore
  let cleaned = base.replace(/[^a-z0-9_]/g, '_');
  // Collapse multiple underscores
  cleaned = cleaned.replace(/_+/g, '_');
  // Ensure it starts with a letter
  if (!/^[a-z]/.test(cleaned)) {
    cleaned = `db_${cleaned}`;
  }
  // Trim leading/trailing underscores after adjustments
  cleaned = cleaned.replace(/^_+|_+$/g, '');
  // Enforce max length (RDS allows up to 64)
  return cleaned.slice(0, 64);
}

export function shouldWarnExternalRelationship(targetMode: string | null, type: string | null): boolean {
  return targetMode === 'External' && !type?.endsWith('/hyperlink') && !type?.endsWith('/attachedTemplate');
}

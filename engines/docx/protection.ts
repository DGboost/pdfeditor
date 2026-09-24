type ProtectionAttribute = Pick<Attr, 'name' | 'localName' | 'namespaceURI' | 'prefix' | 'value'>;

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export function isEnforcedProtection(localName: string, attributes: Iterable<ProtectionAttribute>): boolean {
  if (localName !== 'writeProtection' && localName !== 'documentProtection') return false;
  const carried = [...attributes];
  if (localName === 'writeProtection') {
    // Only recommended-only is advisory; a bare element still protects the document.
    const settings = carried.filter(item => item.name !== 'xmlns' && item.prefix !== 'xmlns');
    return !(settings.length > 0 && settings.every(item => item.localName === 'recommended'
      && (item.namespaceURI === wordNamespace || (item.namespaceURI === null && item.name === 'w:recommended'))));
  }
  const enforcement = carried.find(item => item.namespaceURI === wordNamespace && item.localName === 'enforcement')
    ?? carried.find(item => item.name === 'w:enforcement');
  return enforcement !== undefined && !['0', 'false', 'off'].includes(enforcement.value);
}

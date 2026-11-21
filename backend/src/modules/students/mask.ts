/** What a phone number or an email looks like to someone who is only checking "is this the same parent?". */
export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length <= 4 ? '••••' : `•••••• ${digits.slice(-4)}`;
}

export function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const [name = '', domain = ''] = value.split('@');
  return `${name.slice(0, 1)}•••@${domain}`;
}

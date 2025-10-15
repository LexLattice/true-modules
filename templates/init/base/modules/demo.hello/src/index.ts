export function greet(name: string): string {
  const trimmed = name?.trim();
  const subject = trimmed && trimmed.length ? trimmed : 'there';
  return `Hello, ${subject}!`;
}

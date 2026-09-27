export async function fetchWidget() {
  const response = await fetch('/api/widget', { method: 'GET' });
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}
